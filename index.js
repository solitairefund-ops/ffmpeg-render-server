const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { execSync, exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
const TMP = "/tmp";

// Install yt-dlp on startup
try {
  execSync("which yt-dlp || pip install yt-dlp --quiet");
  console.log("yt-dlp ready");
} catch (e) {
  console.log("yt-dlp install note:", e.message);
}

async function downloadFile(url, dest) {
  const response = await axios({ url, responseType: "stream", timeout: 60000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

async function downloadYouTube(url, dest) {
  return new Promise((resolve, reject) => {
    const cmd = `yt-dlp -f "bestvideo[ext=mp4][height<=1080]+bestaudio/best[ext=mp4]" --merge-output-format mp4 -o "${dest}" "${url}" --no-playlist`;
    console.log("Downloading YouTube video...");
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error("yt-dlp error:", stderr);
        reject(new Error(stderr || error.message));
      } else {
        resolve();
      }
    });
  });
}

app.get("/health", (req, res) => res.json({ status: "ok", yt_dlp: "ready" }));

async function handleRender(params, res) {
  const { video1, audio, title } = params;

  if (!video1 || !audio) {
    return res.status(400).json({ error: "video1 and audio are required", received: params });
  }

  const id = uuidv4();
  const videoPath = path.join(TMP, `${id}_video.mp4`);
  const audioPath = path.join(TMP, `${id}_audio.mp3`);
  const outputPath = path.join(TMP, `${id}_output.mp4`);

  try {
    // Download YouTube video
    console.log("Fetching video:", video1);
    if (video1.includes("youtube.com") || video1.includes("youtu.be")) {
      await downloadYouTube(video1, videoPath);
    } else {
      await downloadFile(video1, videoPath);
    }

    // Download audio
    console.log("Fetching audio:", audio);
    await downloadFile(audio, audioPath);

    // Render with FFmpeg
    console.log("Rendering...");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          "-c:v libx264",
          "-c:a aac",
          "-shortest",
          "-movflags +faststart",
          "-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
          "-r 30",
          "-preset fast",
          "-crf 23",
          "-map 0:v:0",
          "-map 1:a:0"
        ])
        .output(outputPath)
        .on("end", resolve)
        .on("error", (err) => reject(err))
        .run();
    });

    // Stream back the file
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.mp4"`);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => {
      [videoPath, audioPath, outputPath].forEach(f => {
        try { fs.unlinkSync(f); } catch (e) {}
      });
      console.log("Done:", id);
    });

  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
    [videoPath, audioPath, outputPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (e) {}
    });
  }
}

app.get("/render", (req, res) => handleRender(req.query, res));
app.post("/render", (req, res) => handleRender(req.body, res));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
