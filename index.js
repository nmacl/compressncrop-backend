const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const cors = require('cors');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Enable CORS for your Vercel frontend
app.use(cors());

app.get('/', (req, res) => {
  res.json({ status: 'Image processor API is running' });
});

app.post('/api/process', upload.array('images'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images uploaded' });
    }

    const TARGET_WIDTH = 1260;
    const TARGET_HEIGHT = 1726;
    const MAX_FILE_SIZE = 5000; // 5KB in bytes

    // Set up zip stream
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=processed-images.zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // Process each image
    for (const file of req.files) {
      try {
        const originalName = path.parse(file.originalname).name;
        let quality = 80;
        let processedImage;

        // Crop to exact dimensions (cover mode - fills the dimensions)
        let pipeline = sharp(file.buffer)
          .resize(TARGET_WIDTH, TARGET_HEIGHT, {
            fit: 'cover',
            position: 'center'
          })
          .jpeg({ quality });

        processedImage = await pipeline.toBuffer();

        // Reduce quality until file size is under 5KB
        while (processedImage.length > MAX_FILE_SIZE && quality > 10) {
          quality -= 5;
          pipeline = sharp(file.buffer)
            .resize(TARGET_WIDTH, TARGET_HEIGHT, {
              fit: 'cover',
              position: 'center'
            })
            .jpeg({ quality });
          
          processedImage = await pipeline.toBuffer();
        }

        // Add to zip
        archive.append(processedImage, { name: `${originalName}.jpg` });
        
        console.log(`Processed: ${originalName}.jpg - Size: ${processedImage.length} bytes, Quality: ${quality}`);
      } catch (err) {
        console.error(`Error processing ${file.originalname}:`, err);
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error('Error processing images:', error);
    res.status(500).json({ error: 'Failed to process images' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});