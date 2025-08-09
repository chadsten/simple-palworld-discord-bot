/**
 * Palworld REST API Client Module
 * 
 * Simple interface for interacting with the Palworld REST API.
 * 
 * API Documentation: https://tech.palworldgame.com/optimize-game-balance/rest-api
 */
import 'dotenv/config';
import config from './config/index.js';

// Base URL with trailing slash removed for consistent path construction
const BASE = config.palworld.apiUrl?.replace(/\/$/, '');

function getAuthHeader() {
  return 'Basic ' + Buffer.from(`${config.palworld.username}:${config.palworld.password}`).toString('base64');
}

function url(p) { return `${BASE}${p}`; }

async function apiGet(path) {
  const response = await fetch(url(path), {
    headers: { Authorization: getAuthHeader() }
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  return await response.json();
}

async function apiPost(path, body = {}) {
  const response = await fetch(url(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader()
    },
    body: JSON.stringify(body)
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function getInfo() { return apiGet('/info'); }

export async function getPlayers() {
  const data = await apiGet('/players');
  const list = Array.isArray(data) ? data : (data.players || []);
  return list;
}

export async function getMetrics() { return apiGet('/metrics'); }

export async function saveWorld() { return apiPost('/save'); }

export async function shutdown(seconds = 0, message = 'Stopping...') {
  return apiPost('/shutdown', { waittime: seconds, message });
}

export async function isUp() {
  try {
    await apiGet('/info');
    return true;
  } catch {
    return false;
  }
}
