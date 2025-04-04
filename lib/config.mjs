import ospath from 'ospath';
import path from 'path';
import fs from 'fs';

const filePath = path.join(ospath.home(), '.tb');
let config;

try {
  const data = fs.readFileSync(filePath, 'utf-8');
  config = JSON.parse(data);
} catch (error) {
  if (error.code === 'ENOENT') {
    console.info('Settings file not found using default settings.');
  } else if (error instanceof SyntaxError) {
    console.error('Error parsing settings file JSON:', error.message);
  } else {
    console.error('An unexpected error occurred loading settings:', error);
  }
}

export default config;