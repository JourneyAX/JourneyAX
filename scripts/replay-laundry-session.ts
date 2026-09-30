import 'dotenv/config';

async function testTranscript() {
  const url = 'http://localhost:3010/api/v1/placemakers/commerce/chat/stream';
  const sessionId = 'test-laundry-session-' + Date.now();

  const turns = [
    'I want to build a laundry cabinet',
    '100 miters',
    'room soize'
  ];

  for (let i = 0; i < turns.length; i++) {
    const msg = turns[i];
    console.log('\n======================================================');
    console.log(`TURN ${i + 1}: "${msg}"`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'placemakers',
        'Authorization': 'Bearer test-admin-token'
      },
      body: JSON.stringify({
        tenantId: 'placemakers',
        sessionId,
        turnId: `turn-${i + 1}-${Date.now()}`,
        correlationId: `corr-${i + 1}-${Date.now()}`,
        message: msg
      })
    });

    const text = await res.text();
    const lines = text.split('\n');
    for (const l of lines) {
      if (
        l.startsWith('event: trace') ||
        l.startsWith('event: capability') ||
        l.startsWith('event: uiAction') ||
        l.startsWith('event: data') ||
        l.startsWith('data: {"sessionId"') ||
        l.startsWith('data: {"currentStage"') ||
        l.startsWith('data: {"token"')
      ) {
        console.log(l.slice(0, 300));
      }
    }
  }
}
testTranscript();
