#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'weather';
}

function parseArgNumber(raw, fallback) {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNamedArgs(args) {
  const values = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const inlineEqualsIndex = token.indexOf('=');

    if (!token.startsWith('--') && inlineEqualsIndex > 0) {
      const key = token.slice(0, inlineEqualsIndex).trim();
      const value = token.slice(inlineEqualsIndex + 1).trim();
      if (key.length > 0) {
        values[key] = value;
      }
      continue;
    }

    if (!token.startsWith('--')) continue;

    const equalsIndex = token.indexOf('=');
    if (equalsIndex >= 0) {
      const key = token.slice(2, equalsIndex).trim();
      const value = token.slice(equalsIndex + 1).trim();
      if (key.length > 0) {
        values[key] = value;
      }
      continue;
    }

    const key = token.slice(2).trim();
    const value = args[index + 1];
    if (key.length > 0 && value !== undefined && !value.startsWith('--')) {
      values[key] = value;
      index += 1;
    }
  }

  return values;
}

function weatherCodeDescription(code) {
  const mapping = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Depositing rime fog',
    51: 'Light drizzle',
    53: 'Moderate drizzle',
    55: 'Dense drizzle',
    56: 'Light freezing drizzle',
    57: 'Dense freezing drizzle',
    61: 'Slight rain',
    63: 'Moderate rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Heavy freezing rain',
    71: 'Slight snow fall',
    73: 'Moderate snow fall',
    75: 'Heavy snow fall',
    77: 'Snow grains',
    80: 'Slight rain showers',
    81: 'Moderate rain showers',
    82: 'Violent rain showers',
    85: 'Slight snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with slight hail',
    99: 'Thunderstorm with heavy hail',
  };
  return mapping[code] ?? `Unknown weather code (${code})`;
}

async function main() {
  const [, , ...args] = process.argv;
  const namedArgs = parseNamedArgs(args);

  const latitude = parseArgNumber(namedArgs.lat ?? namedArgs.latitude, 37.7749);
  const longitude = parseArgNumber(namedArgs.lon ?? namedArgs.longitude, -122.4194);
  const locationName = (namedArgs.location ?? 'San Francisco, CA').trim() || 'San Francisco, CA';

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(latitude));
  url.searchParams.set('longitude', String(longitude));
  url.searchParams.set('current', [
    'temperature_2m',
    'apparent_temperature',
    'relative_humidity_2m',
    'precipitation',
    'wind_speed_10m',
    'weather_code',
    'is_day',
  ].join(','));
  url.searchParams.set('timezone', 'auto');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  if (!payload?.current) {
    throw new Error('Open-Meteo response missing current weather data');
  }

  const current = payload.current;
  const units = payload.current_units ?? {};
  const observedAt = current.time || new Date().toISOString();
  const canonicalId = `open-meteo:${latitude},${longitude}:${observedAt}`;

  const markdown = [
    '---',
    `id: ${JSON.stringify(canonicalId)}`,
    'source: "open-meteo"',
    `location: ${JSON.stringify(locationName)}`,
    `observedAt: ${JSON.stringify(observedAt)}`,
    `latitude: ${latitude}`,
    `longitude: ${longitude}`,
    '---',
    '',
    `# Current Weather: ${locationName}`,
    '',
    `- Observed at: ${observedAt}`,
    `- Conditions: ${weatherCodeDescription(current.weather_code)}`,
    `- Temperature: ${current.temperature_2m} ${units.temperature_2m ?? ''}`.trim(),
    `- Feels like: ${current.apparent_temperature} ${units.apparent_temperature ?? ''}`.trim(),
    `- Relative humidity: ${current.relative_humidity_2m} ${units.relative_humidity_2m ?? ''}`.trim(),
    `- Precipitation: ${current.precipitation} ${units.precipitation ?? ''}`.trim(),
    `- Wind speed: ${current.wind_speed_10m} ${units.wind_speed_10m ?? ''}`.trim(),
    `- Daytime: ${current.is_day === 1 ? 'yes' : 'no'}`,
    '',
    `Source: ${url.toString()}`,
    '',
  ].join('\n');

  const fileName = `weather-${slugify(locationName)}.md`;
  const outDir = path.resolve(process.cwd(), 'outs');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, fileName), markdown, 'utf-8');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
