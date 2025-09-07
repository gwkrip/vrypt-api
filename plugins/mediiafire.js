const axios = require("axios");

module.exports = {
  path: "/api/mediafire",
  method: "GET",
  name: "MediaFire",
  tags: ["main"],
  description: "get Metadata Download MediaFire",
  authentication: false,
  rateLimit: { limit: 10, window: 60000 },
  timeout: 5000,
  parameter: [{
      name: "url",
      required: false,
      type: "text"
    }],
  exec: async (req, res) => {
    try {
      const { url } = req.query
      const data = await mediafiredl(url)
      
      res.status(200).json({
        success: true,
        result: data
      })
    } catch (e) {
      res.status(500).json({
        success: false,
        message: e.message
      })
    }
  },
};

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9"
};

function parseFileSize(sizeStr) {
  if (!sizeStr) return 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  const match = sizeStr.match(/([\d.,]+)\s*([A-Za-z]+)/);
  if (!match) return 0;
  let value = parseFloat(match[1].replace(",", "."));
  let unit = match[2].toUpperCase();
  let idx = units.indexOf(unit);
  if (idx === -1) idx = 0;
  return Math.round(value * Math.pow(1024, idx));
}

async function mediafiredl(url) {
  const { data: html } = await axios.get(url, { headers: { ...DEFAULT_HEADERS } });
  const urlMatch = html.match(/href="(https?:\/\/download[^"]+)"/);
  const Url = urlMatch ? urlMatch[1] : "";
  const nameMatch = html.match(/<div class="filename">([^<]+)<\/div>/);
  const filename = nameMatch ? nameMatch[1].trim() : "unknown";
  const typeMatch = html.match(/<div class="filetype">.*?<span>([^<]+)<\/span>/s);
  const filetype = typeMatch ? typeMatch[1].trim() : "unknown";
  const extMatch = html.match(/\(\.(.*?)\)/);
  const ext = extMatch ? extMatch[1].trim() : "bin";
  const sizeMatch = html.match(/<li>File size: <span>([^<]+)<\/span><\/li>/);
  const filesizeH = sizeMatch ? sizeMatch[1].trim() : "0 B";
  const filesize = parseFileSize(filesizeH);
  const aploudMatch = html.match(/<li>Uploaded: <span>([^<]+)<\/span><\/li>/);
  const aploud = aploudMatch ? aploudMatch[1].trim() : "unknown";
  return { url: Url, filename, filetype, ext, aploud, filesizeH, filesize };
}

