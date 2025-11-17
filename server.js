const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const cors = require('cors');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Enable CORS for your frontend with more permissive settings
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Session-ID'],
  credentials: false
}));

// Handle OPTIONS requests
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
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  
  // Flush headers immediately
  res.flushHeaders();
  
  // Store response object for this session
  if (!global.progressClients) {
    global.progressClients = new Map();
  }
  global.progressClients.set(sessionId, res);
  
  console.log(`[${sessionId}] SSE connection established`);
  
  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Progress tracking connected' })}\n\n`);
  
  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 15000);
  
  req.on('close', () => {
    console.log(`[${sessionId}] SSE connection closed`);
    clearInterval(heartbeat);
    global.progressClients.delete(sessionId);
  });
});

// Helper function to send progress updates
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
    const MAX_FILE_SIZE = 500000; // 500KB in bytes

    // Set up zip stream
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=processed-images.zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    sendProgress(sessionId, {
      type: 'processing_started',
      message: 'Starting image processing...',
      totalFiles
    });

    // Process each image
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

        let quality = 95; // Start with high quality
        let processedImage;
        let compressionAttempts = 0;

        // Get image metadata to understand the original format
        const metadata = await sharp(file.buffer).metadata();
        const sourceAspectRatio = metadata.width / metadata.height;
        const targetAspectRatio = TARGET_WIDTH / TARGET_HEIGHT;
        const aspectRatioDiff = Math.abs(sourceAspectRatio - targetAspectRatio);
        
        console.log(`[${sessionId}]    Original format: ${metadata.format}, ${metadata.width}x${metadata.height}`);
        console.log(`[${sessionId}]    Aspect ratio: ${sourceAspectRatio.toFixed(3)} (target: ${targetAspectRatio.toFixed(3)}, diff: ${aspectRatioDiff.toFixed(3)})`);
        
        // Check if image is already the correct size and under the file size limit
        const isAlreadyCorrectSize = metadata.width === TARGET_WIDTH && metadata.height === TARGET_HEIGHT;
        const isUnderSizeLimit = file.size <= MAX_FILE_SIZE;
        
        if (isAlreadyCorrectSize && isUnderSizeLimit) {
          console.log(`[${sessionId}]    Image already correct dimensions and under 500KB - using original!`);
          processedImage = file.buffer;
          compressionAttempts = 0;
        } else {
          // Smart cropping: use 'cover' if aspect ratios are similar (< 10% difference), 'contain' if very different
          // This prevents cutting off products while still filling the frame when possible
          const useCover = aspectRatioDiff < 0.1; // 10% threshold
          const fitMode = useCover ? 'cover' : 'contain';
          
          console.log(`[${sessionId}]    Using fit mode: ${fitMode} ${useCover ? '(minimal cropping)' : '(white bars to preserve product)'}`);

          // Create initial pipeline with high-quality resize settings
          let pipeline = sharp(file.buffer)
            .resize(TARGET_WIDTH, TARGET_HEIGHT, {
              fit: fitMode,
              position: useCover ? 'center' : undefined,
              background: { r: 255, g: 255, b: 255, alpha: 1 },
              kernel: sharp.kernel.lanczos3 // High-quality resampling (sharper than default)
            })
            .sharpen() // Add slight sharpening after resize to counteract softening
            .jpeg({ 
              quality,
              mozjpeg: true // Use mozjpeg for better compression
            });

          processedImage = await pipeline.toBuffer();
          compressionAttempts++;

          console.log(`[${sessionId}]    After resize at quality ${quality}: ${(processedImage.length / 1024).toFixed(2)} KB`);

          // Only compress if already over 500KB
          if (processedImage.length > MAX_FILE_SIZE) {
          console.log(`[${sessionId}]    Image over 500KB, starting compression...`);
          
          // Reduce quality until file size is under 500KB
          while (processedImage.length > MAX_FILE_SIZE && quality > 10) {
            quality -= 5;
            
            pipeline = sharp(file.buffer)
              .resize(TARGET_WIDTH, TARGET_HEIGHT, {
                fit: fitMode,
                position: useCover ? 'center' : undefined,
                background: { r: 255, g: 255, b: 255, alpha: 1 },
                kernel: sharp.kernel.lanczos3
              })
              .sharpen()
              .jpeg({ 
                quality,
                mozjpeg: true
              });
            
            processedImage = await pipeline.toBuffer();
            compressionAttempts++;
          }

          // If still too large at quality 10, try more aggressive optimization
          if (processedImage.length > MAX_FILE_SIZE) {
            console.log(`[${sessionId}]    Still too large, applying aggressive compression...`);
            
            pipeline = sharp(file.buffer)
              .resize(TARGET_WIDTH, TARGET_HEIGHT, {
                fit: fitMode,
                position: useCover ? 'center' : undefined,
                background: { r: 255, g: 255, b: 255, alpha: 1 },
                kernel: sharp.kernel.lanczos3
              })
              .sharpen()
              .jpeg({ 
                quality: 10,
                chromaSubsampling: '4:2:0',
                mozjpeg: true
              });
            
            processedImage = await pipeline.toBuffer();
            quality = 10;
          }
        } else {
          console.log(`[${sessionId}]    Image already under 500KB, no compression needed!`);
        }
        } // End of else block for processing (vs using original)

        // Add to zip
        archive.append(processedImage, { name: `${originalName}.jpg` });
        
        processedCount++;
        const fileProcessTime = Date.now() - fileStartTime;
        const compressionRatio = ((1 - processedImage.length / originalSize) * 100).toFixed(1);
        
        console.log(`[${sessionId}] ✓ Completed ${processedCount}/${totalFiles}: ${originalName}.jpg`);
        console.log(`   - Original: ${(originalSize / 1024).toFixed(2)} KB → Final: ${(processedImage.length / 1024).toFixed(2)} KB (${compressionRatio}% reduction)`);
        console.log(`   - Quality: ${quality}%, Attempts: ${compressionAttempts}, Time: ${fileProcessTime}ms`);
        
        sendProgress(sessionId, {
          type: 'file_completed',
          message: `Completed: ${file.originalname}`,
          current: processedCount,
          total: totalFiles,
          filename: file.originalname,
          originalSize: originalSize,
          finalSize: processedImage.length,
          quality: quality,
          compressionRatio: compressionRatio,
          processingTime: fileProcessTime
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
    const avgTimePerFile = processedCount > 0 ? (totalTime / processedCount).toFixed(0) : 0;
    
    console.log(`[${sessionId}] All processing complete: ${processedCount}/${totalFiles} files in ${(totalTime / 1000).toFixed(2)}s (avg ${avgTimePerFile}ms/file)`);
    
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
    
    // Clean up progress client after a delay
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