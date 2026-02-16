const FormData = require('form-data');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');

// WARNING: Token disimpan langsung di sini (tidak aman untuk production)
const VERCEL_TOKEN = 'vcp_6ZKghfaK9liccOibTv9tArk7PTa35rrP44neOOBHngJmaoQveT49j4iy';

// Global deployment counter (reset setiap hari)
let deploymentData = {
  count: 0,
  resetDate: getNextResetDate(),
  lastReset: new Date().toISOString(),
  lastDeployTime: null
};

const MAX_DEPLOYS_PER_DAY = 20;
const COOLDOWN_MINUTES = 3;

function getNextResetDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}

function checkAndResetCounter() {
  const now = new Date();
  const resetDate = new Date(deploymentData.resetDate);
  
  if (now >= resetDate) {
    deploymentData.count = 0;
    deploymentData.resetDate = getNextResetDate();
    deploymentData.lastReset = now.toISOString();
    deploymentData.lastDeployTime = null;
  }
  
  return deploymentData;
}

function getCooldownRemaining() {
  if (!deploymentData.lastDeployTime) return 0;
  
  const now = new Date();
  const lastDeploy = new Date(deploymentData.lastDeployTime);
  const cooldownEnd = new Date(lastDeploy.getTime() + (COOLDOWN_MINUTES * 60 * 1000));
  
  const remaining = Math.max(0, Math.ceil((cooldownEnd - now) / 1000));
  return remaining;
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // GET request - untuk cek deployment count
  if (req.method === 'GET') {
    const data = checkAndResetCounter();
    const cooldownRemaining = getCooldownRemaining();
    
    return res.status(200).json({
      count: data.count,
      maxCount: MAX_DEPLOYS_PER_DAY,
      resetDate: data.resetDate,
      remaining: MAX_DEPLOYS_PER_DAY - data.count,
      cooldownRemaining: cooldownRemaining,
      lastDeployTime: data.lastDeployTime
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    // Check deployment limit
    const currentData = checkAndResetCounter();
    if (currentData.count >= MAX_DEPLOYS_PER_DAY) {
      return res.status(429).json({
        success: false,
        message: `Deployment limit tercapai! Sudah ${MAX_DEPLOYS_PER_DAY} deployment hari ini. Reset pada ${new Date(currentData.resetDate).toLocaleString('id-ID')}`,
        count: currentData.count,
        maxCount: MAX_DEPLOYS_PER_DAY,
        resetDate: currentData.resetDate
      });
    }

    // Check cooldown
    const cooldownRemaining = getCooldownRemaining();
    if (cooldownRemaining > 0) {
      return res.status(429).json({
        success: false,
        message: `Cooldown aktif! Silakan tunggu ${Math.ceil(cooldownRemaining / 60)} menit lagi sebelum deployment berikutnya.`,
        cooldownRemaining: cooldownRemaining
      });
    }

    if (!VERCEL_TOKEN || VERCEL_TOKEN === 'GANTI_DENGAN_TOKEN_KAMU') {
      return res.status(500).json({ 
        success: false, 
        message: 'Vercel token belum diisi' 
      });
    }

    // Parse multipart form data
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('multipart/form-data')) {
      return res.status(400).json({ 
        success: false, 
        message: 'Content-Type harus multipart/form-data' 
      });
    }

    // Get form data dari request
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Parse boundary
    const boundary = contentType.split('boundary=')[1];
    const parts = parseMultipart(buffer, boundary);

    const projectName = parts.projectName;
    const fileData = parts.file;

    if (!projectName) {
      return res.status(400).json({ 
        success: false, 
        message: 'Nama project tidak boleh kosong' 
      });
    }

    if (!fileData) {
      return res.status(400).json({ 
        success: false, 
        message: 'File tidak ditemukan' 
      });
    }

    // Prepare files untuk Vercel deployment
    let files = [];
    const fileName = fileData.filename;

    if (fileName.endsWith('.zip')) {
      // Extract ZIP
      const zip = new AdmZip(fileData.data);
      const zipEntries = zip.getEntries();

      zipEntries.forEach(entry => {
        if (!entry.isDirectory) {
          files.push({
            file: entry.entryName,
            data: entry.getData().toString('base64')
          });
        }
      });
    } else if (fileName.endsWith('.html')) {
      // Single HTML file
      files.push({
        file: 'index.html',
        data: fileData.data.toString('base64')
      });
    } else {
      return res.status(400).json({ 
        success: false, 
        message: 'Format file tidak didukung. Gunakan .html atau .zip' 
      });
    }

    // Pastikan ada file index.html
    const hasIndex = files.some(f => f.file === 'index.html' || f.file.endsWith('/index.html'));
    if (!hasIndex && files.length > 0) {
      // Rename file pertama jadi index.html jika belum ada
      files[0].file = 'index.html';
    }

    // Create deployment payload
    const deploymentPayload = {
      name: projectName,
      files: files,
      projectSettings: {
        framework: null
      }
    };

    // Deploy ke Vercel
    const deployResponse = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VERCEL_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(deploymentPayload)
    });

    const deployData = await deployResponse.json();

    if (!deployResponse.ok) {
      return res.status(deployResponse.status).json({
        success: false,
        message: deployData.error?.message || 'Deployment gagal',
        details: deployData
      });
    }

    // Return success response
    deploymentData.count++;
    deploymentData.lastDeployTime = new Date().toISOString();
    
    return res.status(200).json({
      success: true,
      message: 'Deployment berhasil!',
      url: `https://${deployData.url}`,
      deploymentId: deployData.id,
      inspectorUrl: deployData.inspectorUrl,
      deploymentCount: deploymentData.count,
      remaining: MAX_DEPLOYS_PER_DAY - deploymentData.count,
      cooldownSeconds: COOLDOWN_MINUTES * 60
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Terjadi kesalahan server'
    });
  }
};

// Helper function untuk parse multipart form data
function parseMultipart(buffer, boundary) {
  const result = {};
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  
  let start = 0;
  let end = buffer.indexOf(boundaryBuffer, start);
  
  while (end !== -1) {
    start = end + boundaryBuffer.length + 2; // Skip boundary and CRLF
    end = buffer.indexOf(boundaryBuffer, start);
    
    if (end === -1) break;
    
    const part = buffer.slice(start, end - 2); // Remove trailing CRLF
    
    // Find header end (double CRLF)
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    
    const headerSection = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + 4);
    
    // Parse Content-Disposition
    const nameMatch = headerSection.match(/name="([^"]+)"/);
    const filenameMatch = headerSection.match(/filename="([^"]+)"/);
    
    if (nameMatch) {
      const fieldName = nameMatch[1];
      
      if (filenameMatch) {
        // File field
        result[fieldName] = {
          filename: filenameMatch[1],
          data: body
        };
      } else {
        // Regular field
        result[fieldName] = body.toString();
      }
    }
  }
  
  return result;
}
