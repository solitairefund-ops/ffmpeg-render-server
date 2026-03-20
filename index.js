
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
    params: { query: query || "luxury travel", per_page: 3, orientation: "portrait" }
  });
  const videos = res.data.videos;
  if (!videos || videos.length === 0) throw new Error("No Pexels videos found");
  const video = videos[0];
  const files = video.video_files.sort((a, b) => b.height - a.height);
  const file = files.find(f => f.height <= 1080 && f.file_type === "video/mp4") || files[0];
  console.log("Pexels video URL:", file.link);
  return file.link;
}

async function getVoiceRSSAudio(dest) {
  console.log("Fetching VoiceRSS audio...");
  const url = `https://api.voicerss.org/?key=${VOICERSS_KEY}&hl=en-us&v=John&r=0&c=mp3&f=44khz_16bit_stereo&src=${encodeURIComponent(SCRIPT)}`;
  await downloadFile(url, dest);
  const size = fs.statSync(dest).size;
  console.log("Audio size:", size, "bytes");
  if (size < 1000) throw new Error("VoiceRSS returned empty audio - check API key");
}

app.get("/health", (req, res) => {
  res.json({ status: "ok", mode: "pexels+voicerss+ffmpeg" });
});

async function handleRender(params, res) {
  // query is the only required param now - everything else is internal
  const query = params.query || params.q || "luxury travel";
  const title = params.title || query;

  console.log("Render request - query:", query, "title:", title);

  const id = uuidv4();
  const videoPath = path.join(TMP, `${id}_video.mp4`);
  const audioPath = path.join(TMP, `${id}_audio.mp3`);
  const outputPath = path.join(TMP, `${id}_output.mp4`);

  try {
    // Get Pexels video
    const videoUrl = await getPexelsVideo(query);
    await downloadFile(videoUrl, videoPath);
    console.log("Video downloaded, size:", fs.statSync(videoPath).size);

    // Get VoiceRSS audio
    await getVoiceRSSAudio(audioPath);

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

    console.log("Render done, size:", fs.statSync(outputPath).size);

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
