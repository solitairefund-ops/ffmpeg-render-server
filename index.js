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
const VOICERSS_KEY = "90be4fec507346188e15b5645cb80111";
const SCRIPT = "Most people miss this. But once you see it you start noticing it everywhere. And now you will never be able to ignore it.";

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
    params: { query: query || "luxury travel", per_page: 5, orientation: "portrait" }
  });
  const videos = res.data.videos;
  if (!videos || videos.length === 0) throw new Error("No Pexels videos found");
  
  // Pick smallest file to save memory - max 720p
  const video = videos[0];
  const files = video.video_files.sort((a, b) => a.height - b.height);
  const file = files.find(f => f.height >= 480 && f.file_type === "video/mp4") || files[0];
  console.log("Pexels video:", file.width, "x", file.height, file.link);
  return file.link;
}

async function getVoiceRSSAudio(dest) {
  console.log("Fetching VoiceRSS audio...");
  const url = `https://api.voicerss.org/?key=${VOICERSS_KEY}&hl=en-us&v=John&r=0&c=mp3&f=22khz_8bit_mono&src=${encodeURIComponent(SCRIPT)}`;
  await downloadFile(url, dest);
  const size = fs.statSync(dest).size;
  console.log("Audio size:", size, "bytes");
  if (size < 1000) throw new Error("VoiceRSS returned empty audio");
}

app.get("/health", (req, res) => {
  const { exec } = require("child_process");
  exec("ffmpeg -version", (err, stdout) => {
    res.json({ status: err ? "error" : "ok", ffmpeg: err ? "not found" : "ready" });
  });
});

async function handleRender(params, res) {
  const query = params.query || "luxury travel";
  const title = params.title || query;
  console.log("Render - query:", query);

  const id = uuidv4();
  const videoPath = path.join(TMP, `${id}_v.mp4`);
  const audioPath = path.join(TMP, `${id}_a.mp3`);
  const outputPath = path.join(TMP, `${id}_out.mp4`);

  try {
    const videoUrl = await getPexelsVideo(query);
    await downloadFile(videoUrl, videoPath);
    console.log("Video:", fs.statSync(videoPath).size, "bytes");

    await getVoiceRSSAudio(audioPath);

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
          // Scale to 540x960 instead of 1080x1920 - uses 4x less memory
          "-vf scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2,setsar=1",
          "-r 24",
          // ultrafast preset uses minimal memory
          "-preset ultrafast",
          "-crf 28",
          "-map 0:v:0",
          "-map 1:a:0",
          // Limit threads to avoid OOM
          "-threads 1"
        ])
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    console.log("Done:", fs.statSync(outputPath).size, "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.mp4"`);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => {
      [videoPath, audioPath, outputPath].forEach(f => {
        try { fs.unlinkSync(f); } catch (e) {}
      });
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
