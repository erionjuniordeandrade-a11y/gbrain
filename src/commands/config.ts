import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, saveConfig, type GBrainConfig } from '../core/config.ts';

function redactUrl(url: string): string {
  // Redact password in postgresql:// URLs
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

export async function runConfig(engine: BrainEngine, args: string[]) {
  const action = args[0];
  const key = args[1];
  const value = args[2];

  if (action === 'show') {
    printFileConfig();
    return;
  }

  if (action === 'get' && key) {
    if (isFilePlaneConfigKey(key)) {
      const config = loadConfig();
      const val = config?.[key];
      if (val !== undefined && val !== null) {
        console.log(val);
        return;
      }
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
    const val = await engine.getConfig(key);
    if (val !== null) {
      console.log(val);
    } else {
      console.error(`Config key not found: ${key}`);
      process.exit(1);
    }
  } else if (action === 'set' && key && value) {
    if (isFilePlaneConfigKey(key)) {
      setFileConfigValue(key, value);
      return;
    }
    await engine.setConfig(key, value);
    console.log(`Set ${key} = ${value}`);
  } else {
    console.error('Usage: gbrain config [show|get|set] <key> [value]');
    process.exit(1);
  }
}

export function runConfigFileOnly(args: string[]): boolean {
  const action = args[0];
  const key = args[1];
  const value = args[2];

  if (action === 'show') {
    printFileConfig();
    return true;
  }

  if (action === 'get' && key && isFilePlaneConfigKey(key)) {
    const config = loadConfig();
    const val = config?.[key];
    if (val !== undefined && val !== null) {
      console.log(val);
      return true;
    }
    console.error(`Config key not found: ${key}`);
    process.exit(1);
  }

  if (action === 'set' && key && value && isFilePlaneConfigKey(key)) {
    setFileConfigValue(key, value);
    return true;
  }

  return false;
}

const FILE_PLANE_CONFIG_KEYS = new Set<keyof GBrainConfig>([
  'embedding_model',
  'embedding_dimensions',
  'expansion_model',
  'chat_model',
  'openai_api_key',
  'anthropic_api_key',
  'google_api_key',
]);

function isFilePlaneConfigKey(key: string): key is keyof GBrainConfig {
  return FILE_PLANE_CONFIG_KEYS.has(key as keyof GBrainConfig);
}

function parseFilePlaneValue(key: keyof GBrainConfig, value: string): string | number {
  if (key === 'embedding_dimensions') {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      console.error(`Invalid embedding_dimensions: ${value}`);
      process.exit(1);
    }
    return parsed;
  }
  return value;
}

function printFileConfig(): void {
  const config = loadConfig();
  if (!config) {
    console.error('No config found. Run: gbrain init');
    process.exit(1);
  }
  console.log('GBrain config:');
  for (const [k, v] of Object.entries(config)) {
    const display = typeof v === 'string' && v.includes('postgresql://')
      ? redactUrl(v)
      : typeof v === 'string' && (k.includes('key') || k.includes('secret'))
        ? '***'
        : v;
    console.log(`  ${k}: ${display}`);
  }
}

function setFileConfigValue(key: keyof GBrainConfig, value: string): void {
  const config = loadConfig();
  if (!config) {
    console.error('No config found. Run: gbrain init');
    process.exit(1);
  }
  const parsedValue = parseFilePlaneValue(key, value);
  saveConfig({ ...config, [key]: parsedValue });
  console.log(`Set ${key} = ${key.includes('key') || key.includes('secret') ? '***' : parsedValue}`);
}
