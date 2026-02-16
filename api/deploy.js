const VERCEL_TOKEN = 'vcp_6ZKghfaK9liccOibTv9tArk7PTa35rrP44neOOBHngJmaoQveT49j4iy';

const MAX_DEPLOYS_PER_DAY = 20;
const COOLDOWN_MINUTES = 3;

let deploymentData = {
  count: 0,
  resetDate: getNextResetDate(),
  lastDeployTime: null
};

function getNextResetDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}

function checkAndResetCounter() {
  const now = new Date();
  if (now >= new Date(deploymentData.resetDate)) {
    deploymentData.count = 0;
    deploymentData.resetDate = getNextResetDate();
    deploymentData.lastDeployTime = null;
  }
  return deploymentData;
}

function getCooldownRemaining() {
  if (!deploymentData.lastDeployTime) return 0;
  const cooldownEnd = new Date(new Date(deploymentData.lastDeployTime).getTime() + COOLDOWN_MINUTES * 60 * 1000);
  return Math.max(0, Math.ceil((cooldownEnd - new Date()) / 1000));
}

function generateUniqueName(input) {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30);

  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }

  return `${cleaned}-${suffix}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const data = checkAndResetCounter();
    return res.status(200).json({
      count: data.count,
      maxCount: MAX_DEPLOYS_PER_DAY,
      resetDate: data.resetDate,
      remaining: MAX_DEPLOYS_PER_DAY - data.count,
      cooldownRemaining: getCooldownRemaining(),
      lastDeployTime: data.lastDeployTime
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = checkAndResetCounter();

    if (data.count >= MAX_DEPLOYS_PER_DAY) {
      return res.status(429).json({
        error: `Limit deployment tercapai. Sudah ${MAX_DEPLOYS_PER_DAY} deployment hari ini. Reset pada ${new Date(data.resetDate).toLocaleString('id-ID')}`,
        resetDate: data.resetDate
      });
    }

    const cooldownRemaining = getCooldownRemaining();
    if (cooldownRemaining > 0) {
      return res.status(429).json({
        error: `Cooldown aktif. Tunggu ${Math.ceil(cooldownRemaining / 60)} menit lagi.`,
        cooldownRemaining
      });
    }

    const { name, fileData, fileName } = req.body;

    if (!name || !fileData || !fileName) {
      return res.status(400).json({ error: 'Data tidak lengkap' });
    }

    if (!name.trim()) {
      return res.status(400).json({ error: 'Nama project tidak boleh kosong' });
    }

    const projectName = generateUniqueName(name);

    const headers = {
      'Authorization': `Bearer ${VERCEL_TOKEN}`,
      'Content-Type': 'application/json'
    };

    if (!fileName.endsWith('.html')) {
      return res.status(400).json({ error: 'Format tidak didukung. Gunakan file .html' });
    }

    const files = [{ file: 'index.html', data: fileData, encoding: 'base64' }];

    await fetch('https://api.vercel.com/v9/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: projectName })
    }).catch(() => {});

    const deployResponse = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: projectName,
        project: projectName,
        files,
        projectSettings: { framework: null }
      })
    });

    if (!deployResponse.ok) {
      const errorData = await deployResponse.json();
      return res.status(deployResponse.status).json({
        error: errorData.error?.message || 'Deployment gagal'
      });
    }

    await deployResponse.json();

    deploymentData.count++;
    deploymentData.lastDeployTime = new Date().toISOString();

    return res.status(200).json({
      success: true,
      url: `https://${projectName}.vercel.app`,
      projectName,
      deploymentCount: deploymentData.count,
      remaining: MAX_DEPLOYS_PER_DAY - deploymentData.count,
      cooldownSeconds: COOLDOWN_MINUTES * 60
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
                      }
