const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
const TMP = "/tmp";

async function downloadFile(url, dest) {
  const response = await axios({
    url,
    responseType: "stream",
    timeout: 120000,
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
    // Try multiple possible yt-dlp paths
    const ytdlpPaths = [
      "yt-dlp",
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      "python3 -m yt_dlp"
    ];

    const tryPath = (index) => {
      if (index >= ytdlpPaths.length) {
        return reject(new Error("yt-dlp not found in any path"));
      }
      const bin = ytdlpPaths[index];
      const cmd = `${bin} -f "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best" --merge-output-format mp4 -o "${dest}" "${url}" --no-playlist --no-warnings`;
      exec(cmd, { timeout: 180000 }, (error, stdout, stderr) => {
        if (error) {
          console.log(`${bin} failed, trying next...`);
          tryPath(index + 1);
        } else {
          console.log("Downloaded with:", bin);
          resolve();
        }
      });
    };
    tryPath(0);
  });
}

app.get("/health", (req, res) => {
  exec("which yt-dlp || python3 -m yt_dlp --version", (err, stdout) => {
    res.json({ status: "ok", yt_dlp: stdout.trim() || "checking..." });
  });
});

async function handleRender(params, res) {
  const { video1, audio, title } = params;

  if (!video1 || !audio) {
    return res.status(400).json({
      error: "video1 and audio are required",
      received: Object.keys(params)
    });
  }

  const id = uuidv4();
  const videoPath = path.join(TMP, `${id}_video.mp4`);
  const audioPath = path.join(TMP, `${id}_audio.mp3`);
  const outputPath = path.join(TMP, `${id}_output.mp4`);

  try {
    console.log("Downloading YouTube video:", video1);
    await downloadYouTube(video1, videoPath);

    console.log("Downloading audio:", audio);
    await downloadFile(audio, audioPath);

    console.log("Rendering with FFmpeg...");
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
        .on("error", reject)
        .run();
    });

    console.log("Streaming output...");
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
    console.error("Render failed:", err.message);
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
