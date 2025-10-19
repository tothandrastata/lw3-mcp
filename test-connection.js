import { LW3Protocol } from './src/lw3-protocol.js';

const lw3 = new LW3Protocol();

// Listen to all responses
lw3.on('response', (line) => {
  console.log('[RESPONSE]', line);
});

lw3.on('error', (error) => {
  console.error('[ERROR]', error.message);
});

lw3.on('disconnected', () => {
  console.log('[DISCONNECTED]');
  process.exit(0);
});

async function test() {
  try {
    console.log('Connecting to jimmy-hc40.local:6107...');
    await lw3.connect('jimmy-hc40.local', 6107);
    console.log('Connected successfully!\n');

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Test GET command
    console.log('\n--- Testing GET command ---');
    console.log('Sending: GET /V1/EDID.EdidStatus');
    const getResult = await lw3.get('/V1/EDID.EdidStatus');
    console.log('GET Result:', getResult);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Test another GET
    console.log('\n--- Testing another GET ---');
    console.log('Sending: GET /V1/TEMPERATURES.TempIn1');
    const getResult2 = await lw3.get('/V1/TEMPERATURES.TempIn1');
    console.log('GET Result:', getResult2);

    await new Promise(resolve => setTimeout(resolve, 500));

    // Test GETALL command
    console.log('\n--- Testing GETALL command ---');
    console.log('Sending: GETALL /V1/*');
    const getAllResult = await lw3.getAll('/V1/*');
    console.log(`GETALL Result (${getAllResult.length} items):`);
    getAllResult.forEach((line, idx) => {
      console.log(`  [${idx + 1}] ${line}`);
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    // Disconnect
    console.log('\nDisconnecting...');
    await lw3.disconnect();
    console.log('Test complete!');
    process.exit(0);

  } catch (error) {
    console.error('Test failed:', error.message);
    if (lw3.isConnected()) {
      await lw3.disconnect();
    }
    process.exit(1);
  }
}

test();
