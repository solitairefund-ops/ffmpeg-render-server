const express = require("express");
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());

const TMP = "/tmp";

async function downloadFile(url, dest) {
  const response = await axios({ url, responseType: "stream" });
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/render", async (req, res) => {
  const { video1, video2, video3, audio, title } = req.body;

  if (!video1 || !audio) {
    return res.status(400).json({ error: "video1 and audio are required" });
  }

  const id = uuidv4();
  const v1Path = path.join(TMP, `${id}_v1.mp4`);
  const v2Path = path.join(TMP, `${id}_v2.mp4`);
  const v3Path = path.join(TMP, `${id}_v3.mp4`);
  const audioPath = path.join(TMP, `${id}_audio.mp3`);
  const concatPath = path.join(TMP, `${id}_concat.txt`);
  const outputPath = path.join(TMP, `${id}_output.mp4`);

  try {
    // Download all files
    console.log("Downloading files...");
    await downloadFile(video1, v1Path);
    await downloadFile(audio, audioPath);

    let concatContent = `file '${v1Path}'\n`;

    if (video2) {
      await downloadFile(video2, v2Path);
      concatContent += `file '${v2Path}'\n`;
    }
    if (video3) {
      await downloadFile(video3, v3Path);
      concatContent += `file '${v3Path}'\n`;
    }

    fs.writeFileSync(concatPath, concatContent);

    // Combine clips and add audio
    console.log("Rendering...");
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatPath)
        .inputOptions(["-f concat", "-safe 0"])
        .input(audioPath)
        .outputOptions([
          "-c:v libx264",
          "-c:a aac",
          "-shortest",
          "-movflags +faststart",
          "-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2",
          "-r 30",
          "-preset fast",
          "-crf 23"
        ])
        .output(outputPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    // Send back the file
    console.log("Sending file...");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="${id}.mp4"`);
    const stream = fs.createReadStream(outputPath);
    stream.pipe(res);
    stream.on("end", () => {
      // Cleanup
      [v1Path, v2Path, v3Path, audioPath, concatPath, outputPath].forEach(f => {
        try { fs.unlinkSync(f); } catch (e) {}
      });
    });

  } catch (err) {
    console.error("Render error:", err.message);
    res.status(500).json({ error: err.message });
    [v1Path, v2Path, v3Path, audioPath, concatPath, outputPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (e) {}
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg render server running on port ${PORT}`));
