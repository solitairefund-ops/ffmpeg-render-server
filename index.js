const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());
const TMP = "/tmp";
const PEXELS_KEY = "Us2Mb7nrDT69ZGeOwuIzNplO3xHjjQipjcYnmN0QFJjeOBB37nCR8Jo6";

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

async function getPexelsVideo(query) {
  console.log("Fetching Pexels video for:", query);
  const res = await axios.get("https://api.pexels.com/videos/search", {
    headers: { Authorization: PEXELS_KEY },
    params: { query, per_page: 3, orientation: "portrait" }
  });
  const videos = res.data.videos;
  if (!videos || videos.length === 0) throw new Error("No Pexels videos found for: " + query);
  // Pick highest quality file under 1080p
  const video = videos[0];
  const files = video.video_files.sort((a, b) => b.height - a.height);
  const file = files.find(f => f.height <= 1080 && f.file_type === "video/mp4") || files[0];
  console.log("Got Pexels video:", file.link);
  return file.link;
}

app.get("/health", (req, res) => res.json({ status: "ok", mode: "pexels+ffmpeg" }));

async function handleRender(params, res) {
  const { query, audio, title } = params;

  if (!query || !audio) {
    return res.status(400).json({
      error: "query and audio are required",
      received: Object.keys(params)
    });
  }

  const id = uuidv4();
  const videoPath = path.join(TMP, `${id}_video.mp4`);
  const audioPath = path.join(TMP, `${id}_audio.mp3`);
  const outputPath = path.join(TMP, `${id}_output.mp4`);

  try {
    // Get video from Pexels
    const videoUrl = await getPexelsVideo(query);
    console.log("Downloading video...");
    await downloadFile(videoUrl, videoPath);

    // Download audio
    console.log("Downloading audio...");
    await downloadFile(audio, audioPath);

    // Render
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
          "-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
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
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
