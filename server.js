const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const cors = require('cors');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Session-ID'],
  credentials: false
}));

app.options('*', cors());

app.get('/', (req, res) => {
  res.json({ status: 'Image processor API is running' });
});

// SSE endpoint for progress updates
app.get('/api/progress/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  
  console.log(`[${sessionId}] SSE connection request received`);
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');
  
  res.flushHeaders();
  
  if (!global.progressClients) {
    global.progressClients = new Map();
  }
  global.progressClients.set(sessionId, res);
  
  console.log(`[${sessionId}] SSE connection established`);
  
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Progress tracking connected' })}\n\n`);
  
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15000);
  
  req.on('close', () => {
    console.log(`[${sessionId}] SSE connection closed`);
    clearInterval(heartbeat);
    global.progressClients.delete(sessionId);
  });
});

function sendProgress(sessionId, data) {
  if (!global.progressClients) return;
  
  const client = global.progressClients.get(sessionId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
    console.log(`[${sessionId}] Progress sent:`, data.type);
  }
}

app.post('/api/process', upload.array('images'), async (req, res) => {
  const sessionId = req.headers['x-session-id'] || 'unknown';
  
  try {
    if (!req.files || req.files.length === 0) {
      console.log(`[${sessionId}] No images uploaded`);
      return res.status(400).json({ error: 'No images uploaded' });
    }

    const totalFiles = req.files.length;
    const totalSize = req.files.reduce((sum, file) => sum + file.size, 0);
    
    console.log(`[${sessionId}] Upload complete: ${totalFiles} files, ${(totalSize / 1024 / 1024).toFixed(2)} MB total`);
    
    sendProgress(sessionId, {
      type: 'upload_complete',
      message: `Received ${totalFiles} images (${(totalSize / 1024 / 1024).toFixed(2)} MB)`,
      totalFiles
    });

    const TARGET_WIDTH = 1260;
    const TARGET_HEIGHT = 1726;
    const TARGET_ASPECT_RATIO = TARGET_WIDTH / TARGET_HEIGHT;
    const MAX_FILE_SIZE = 500000; // 500KB

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=processed-images.zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    sendProgress(sessionId, {
      type: 'processing_started',
      message: 'Starting image processing...',
      totalFiles
    });

    let processedCount = 0;
    const startTime = Date.now();

    for (const file of req.files) {
      const fileStartTime = Date.now();
      
      try {
        const originalName = path.parse(file.originalname).name;
        const originalSize = file.size;
        
        console.log(`[${sessionId}] Processing ${processedCount + 1}/${totalFiles}: ${file.originalname} (${(originalSize / 1024).toFixed(2)} KB)`);
        
        sendProgress(sessionId, {
          type: 'processing_file',
          message: `Processing: ${file.originalname}`,
          current: processedCount + 1,
          total: totalFiles,
          filename: file.originalname
        });

        const metadata = await sharp(file.buffer).metadata();
        const sourceAspectRatio = metadata.width / metadata.height;
        
        console.log(`[${sessionId}]    Original: ${metadata.format}, ${metadata.width}x${metadata.height} (AR: ${sourceAspectRatio.toFixed(3)})`);

        let processedImage;
        let action = '';
        
        // Check if aspect ratio matches (within 1% tolerance)
        const aspectRatioMatches = Math.abs(sourceAspectRatio - TARGET_ASPECT_RATIO) < 0.01;
        
        // If already correct aspect ratio and under 500KB, use original
        if (aspectRatioMatches && originalSize <= MAX_FILE_SIZE) {
          console.log(`[${sessionId}]    ✓ Correct aspect ratio and under 500KB - using original!`);
          processedImage = file.buffer;
          action = 'kept_original';
        } 
        // If image is smaller than target, just crop to aspect ratio (no upscaling)
        else if (metadata.width < TARGET_WIDTH || metadata.height < TARGET_HEIGHT) {
          console.log(`[${sessionId}]    Image is smaller than target - cropping to aspect ratio only (no upscaling)`);
          
          // Calculate dimensions to crop to target aspect ratio without upscaling
          let cropWidth, cropHeight;
          
          if (sourceAspectRatio > TARGET_ASPECT_RATIO) {
            // Image is wider - crop width
            cropHeight = metadata.height;
            cropWidth = Math.round(cropHeight * TARGET_ASPECT_RATIO);
          } else {
            // Image is taller - crop height
            cropWidth = metadata.width;
            cropHeight = Math.round(cropWidth / TARGET_ASPECT_RATIO);
          }
          
          console.log(`[${sessionId}]    Cropping from ${metadata.width}x${metadata.height} to ${cropWidth}x${cropHeight}`);
          
          processedImage = await sharp(file.buffer)
            .extract({
              left: Math.round((metadata.width - cropWidth) / 2),
              top: Math.round((metadata.height - cropHeight) / 2),
              width: cropWidth,
              height: cropHeight
            })
            .jpeg({ 
              quality: 92,
              mozjpeg: true
            })
            .toBuffer();
          
          action = 'cropped_only';
        }
        // If image is larger, downscale to target dimensions
        else {
          console.log(`[${sessionId}]    Downscaling from ${metadata.width}x${metadata.height} to ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
          
          processedImage = await sharp(file.buffer)
            .resize(TARGET_WIDTH, TARGET_HEIGHT, {
              fit: 'cover',
              position: 'center'
            })
            .jpeg({ 
              quality: 90,
              mozjpeg: true
            })
            .toBuffer();
          
          console.log(`[${sessionId}]    After downscale: ${(processedImage.length / 1024).toFixed(2)} KB`);
          
          // If still over 500KB, compress further
          if (processedImage.length > MAX_FILE_SIZE) {
            console.log(`[${sessionId}]    Compressing to under 500KB...`);
            let quality = 85;
            
            while (processedImage.length > MAX_FILE_SIZE && quality > 60) {
              processedImage = await sharp(file.buffer)
                .resize(TARGET_WIDTH, TARGET_HEIGHT, {
                  fit: 'cover',
                  position: 'center'
                })
                .jpeg({ 
                  quality,
                  mozjpeg: true
                })
                .toBuffer();
              
              quality -= 5;
            }
            
            console.log(`[${sessionId}]    Compressed to: ${(processedImage.length / 1024).toFixed(2)} KB at quality ${quality + 5}`);
          }
          
          action = 'downscaled';
        }

        archive.append(processedImage, { name: `${originalName}.jpg` });
        
        processedCount++;
        const fileProcessTime = Date.now() - fileStartTime;
        
        console.log(`[${sessionId}] ✓ Completed ${processedCount}/${totalFiles}: ${originalName}.jpg [${action}]`);
        console.log(`   - ${(originalSize / 1024).toFixed(2)} KB → ${(processedImage.length / 1024).toFixed(2)} KB (${fileProcessTime}ms)`);
        
        sendProgress(sessionId, {
          type: 'file_completed',
          message: `Completed: ${file.originalname}`,
          current: processedCount,
          total: totalFiles,
          filename: file.originalname,
          originalSize: originalSize,
          finalSize: processedImage.length,
          processingTime: fileProcessTime,
          action: action
        });

      } catch (err) {
        console.error(`[${sessionId}] ✗ Error processing ${file.originalname}:`, err);
        
        sendProgress(sessionId, {
          type: 'file_error',
          message: `Failed: ${file.originalname}`,
          current: processedCount,
          total: totalFiles,
          filename: file.originalname,
          error: err.message
        });
      }
    }

    const totalTime = Date.now() - startTime;
    
    console.log(`[${sessionId}] All processing complete: ${processedCount}/${totalFiles} files in ${(totalTime / 1000).toFixed(2)}s`);
    
    sendProgress(sessionId, {
      type: 'creating_zip',
      message: 'Creating zip file...',
      processedCount,
      totalTime
    });

    await archive.finalize();
    
    const finalSize = archive.pointer();
    console.log(`[${sessionId}] Zip finalized: ${(finalSize / 1024 / 1024).toFixed(2)} MB`);
    
    sendProgress(sessionId, {
      type: 'complete',
      message: 'All images processed successfully!',
      processedCount,
      totalFiles,
      totalTime,
      zipSize: finalSize
    });
    
    setTimeout(() => {
      if (global.progressClients) {
        global.progressClients.delete(sessionId);
      }
    }, 5000);

  } catch (error) {
    console.error(`[${sessionId}] Fatal error processing images:`, error);
    
    sendProgress(sessionId, {
      type: 'error',
      message: 'Fatal error occurred',
      error: error.message
    });
    
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to process images' });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});