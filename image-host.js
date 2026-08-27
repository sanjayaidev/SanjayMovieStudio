// image-host.js - Uploads local frame images to imgbb for public URL
const axios = require('axios');
const fs = require('fs');
const path = require('path'); // ✅ FIXED: Added missing import

async function uploadImageToImgbb(imagePath) {
  if (!process.env.IMGBB_API_KEY) {
    console.warn('⚠️ IMGBB_API_KEY not set - continuity will be skipped');
    return null;
  }

  if (!fs.existsSync(imagePath)) {
    console.error(`❌ Image not found: ${imagePath}`);
    return null;
  }

  try {
    console.log(`📤 Uploading frame to imgbb: ${path.basename(imagePath)}`);
    console.log(`File size: ${fs.statSync(imagePath).size} bytes`);

    const imageData = fs.readFileSync(imagePath, { encoding: 'base64' });
    
    const params = new URLSearchParams();
    params.append('key', process.env.IMGBB_API_KEY);
    params.append('image', imageData);

    const response = await axios.post('https://api.imgbb.com/1/upload', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });

    const url = response.data?.data?.url;
    if (url) {
      console.log(`✅ Frame hosted publicly: ${url}`);
      return url;
    }

    console.warn('⚠️ imgbb upload succeeded but no URL in response');
    return null;
  } catch (error) {
    console.error('❌ Frame upload to imgbb failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

module.exports = { uploadImageToImgbb };