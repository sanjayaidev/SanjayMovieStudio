// ffmpeg-utils.js - Complete FFmpeg utilities with absolute paths
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// ============================================================
// FFMPEG PATH DETECTION - Use absolute paths
// ============================================================
let ffmpegStaticPath = null;
let ffprobeStaticPath = null;

// Load ffmpeg-static
try {
  ffmpegStaticPath = require('ffmpeg-static');
  console.log(`✅ ffmpeg-static found: ${ffmpegStaticPath}`);
} catch (e) {
  console.log('⚠️ ffmpeg-static not found');
}

// Load ffprobe-static
try {
  ffprobeStaticPath = require('ffprobe-static').path;
  console.log(`✅ ffprobe-static found: ${ffprobeStaticPath}`);
} catch (e) {
  console.log('⚠️ ffprobe-static not found');
}

// Determine final paths - PRIORITIZE the static binaries
let finalFfmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath || 'ffmpeg';
let finalFfprobePath = process.env.FFPROBE_PATH || ffprobeStaticPath || 'ffprobe';

// On Windows, if static path exists but is a relative path, resolve it
if (process.platform === 'win32' && ffmpegStaticPath) {
  finalFfmpegPath = path.resolve(ffmpegStaticPath);
  console.log(`🔧 Using FFmpeg: ${finalFfmpegPath}`);
}

if (process.platform === 'win32' && ffprobeStaticPath) {
  finalFfprobePath = path.resolve(ffprobeStaticPath);
  console.log(`🔧 Using FFprobe: ${finalFfprobePath}`);
}

// Set FFmpeg paths in fluent-ffmpeg
try {
  ffmpeg.setFfmpegPath(finalFfmpegPath);
  ffmpeg.setFfprobePath(finalFfprobePath);
  console.log(`🔧 FFmpeg configured: ${finalFfmpegPath}`);
  console.log(`🔧 FFprobe configured: ${finalFfprobePath}`);
} catch (err) {
  console.error('❌ Failed to set FFmpeg paths:', err.message);
}

// ============================================================
// FUNCTIONS
// ============================================================

/**
 * Extract the last frame from a video - using exec for reliability
 */
function extractLastFrame(videoPath, outputPath) {
  return new Promise(async (resolve, reject) => {
    console.log(`🎞️ Extracting last frame from ${path.basename(videoPath)}`);
    console.log(`Input exists: ${fs.existsSync(videoPath)}`);

    if (!fs.existsSync(videoPath)) {
      const err = new Error(`Input video not found: ${videoPath}`);
      console.error(`❌ ${err.message}`);
      reject(err);
      return;
    }

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const absVideoPath = path.resolve(videoPath);
    const absOutputPath = path.resolve(outputPath);

    if (!fs.existsSync(finalFfmpegPath) && finalFfmpegPath !== 'ffmpeg') {
      console.error(`❌ FFmpeg not found at: ${finalFfmpegPath}`);
      reject(new Error(`FFmpeg not found at: ${finalFfmpegPath}`));
      return;
    }

    console.log(`FFmpeg: ${finalFfmpegPath}`);
    console.log(`Input: ${absVideoPath}`);
    console.log(`Output: ${absOutputPath}`);

    // FIX: Use exec to reliably extract the last frame using -sseof
    // -sseof -0.1 seeks to 0.1 seconds before the end of the file
    // -frames:v 1 extracts exactly one frame
    // -q:v 2 sets high quality for the JPEG
    const command = `"${finalFfmpegPath}" -y -sseof -0.1 -i "${absVideoPath}" -update 1 -frames:v 1 -q:v 2 "${absOutputPath}"`;

    console.log(`🔧 FFmpeg command: ${command}`);

    try {
      const { stdout, stderr } = await exec(command);
      if (fs.existsSync(absOutputPath)) {
        console.log(`✅ Frame extracted: ${path.basename(absOutputPath)}`);
        console.log(`File size: ${fs.statSync(absOutputPath).size} bytes`);
        resolve(absOutputPath);
      } else {
        console.error(`❌ Frame file not found at: ${absOutputPath}`);
        console.error(`FFmpeg stderr: ${stderr}`);
        reject(new Error('Frame extraction completed but output file not found'));
      }
    } catch (err) {
      console.error(`❌ Frame extraction failed:`, err.message);
      if (err.stderr) console.error(`FFmpeg stderr: ${err.stderr}`);
      reject(err);
    }
  });
}

/**
 * Concatenate multiple videos into one
 */
function concatVideos(videoPaths, outputPath) {
  return new Promise((resolve, reject) => {
    if (!videoPaths || videoPaths.length === 0) {
      reject(new Error('No videos to concatenate'));
      return;
    }

    console.log(`🎞️ Concatenating ${videoPaths.length} videos...`);

    for (const vp of videoPaths) {
      if (!fs.existsSync(vp)) {
        reject(new Error(`Video not found: ${vp}`));
        return;
      }
    }

    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (videoPaths.length === 1) {
      fs.copyFileSync(videoPaths[0], outputPath);
      console.log(`✅ Single video copied: ${path.basename(outputPath)}`);
      resolve(outputPath);
      return;
    }

    const uploadsDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const listPath = path.join(uploadsDir, `concat-list-${Date.now()}.txt`);
    
    // Use absolute paths with forward slashes for Windows
    const listContent = videoPaths.map(p => {
      // FIX: Changed /\/g to /\\/g to properly escape backslashes in regex
      const absPath = path.resolve(p).replace(/\\/g, '/');
      return `file '${absPath}'`;
    }).join('\n');

    fs.writeFileSync(listPath, listContent);

    const absOutputPath = path.resolve(outputPath);

    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .output(absOutputPath)
      .outputOptions(['-c', 'copy'])
      .on('start', (cmd) => {
        console.log(`🔧 FFmpeg command: ${cmd}`);
      })
      .on('end', () => {
        console.log(`✅ Videos concatenated: ${path.basename(absOutputPath)}`);
        try {
          if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
        } catch (e) {}
        
        if (fs.existsSync(absOutputPath)) {
          resolve(absOutputPath);
        } else {
          reject(new Error('Concatenation completed but output file not found'));
        }
      })
      .on('error', (err) => {
        console.error(`❌ Concatenation failed:`, err.message);
        try {
          if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
        } catch (e) {}
        reject(err);
      })
      .run();
  });
}

/**
 * Check if FFmpeg is installed
 */
async function checkFFmpeg() {
  try {
    if (fs.existsSync(finalFfmpegPath)) {
      return true;
    }
    await exec('ffmpeg -version');
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get video info
 */
function getVideoInfo(videoPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(videoPath)) {
      reject(new Error(`Video not found: ${videoPath}`));
      return;
    }

    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.error('FFprobe error:', err.message);
        reject(err);
        return;
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
      
      let fps = null;
      if (videoStream && videoStream.avg_frame_rate) {
        const parts = videoStream.avg_frame_rate.split('/');
        if (parts.length === 2 && parseFloat(parts[1]) !== 0) {
          fps = parseFloat(parts[0]) / parseFloat(parts[1]);
        }
      }

      resolve({
        duration: metadata.format.duration || 0,
        size: metadata.format.size || 0,
        bitrate: metadata.format.bit_rate || 0,
        video: videoStream ? {
          codec: videoStream.codec_name,
          width: videoStream.width,
          height: videoStream.height,
          fps: fps,
        } : null,
        audio: audioStream ? {
          codec: audioStream.codec_name,
          channels: audioStream.channels,
          sample_rate: audioStream.sample_rate,
        } : null,
      });
    });
  });
}

module.exports = {
  extractLastFrame,
  concatVideos,
  checkFFmpeg,
  getVideoInfo,
};