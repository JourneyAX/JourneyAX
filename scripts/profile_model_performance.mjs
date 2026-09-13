import OpenAI from 'openai';
import { execSync } from 'child_process';

const CLOUD_RUN_URL = 'https://jax-placemakers-server-515988776244.us-central1.run.app/v1';
const MODEL_NAME = 'jax-placemakers-1.0';

function getAuthToken() {
  try {
    return execSync('gcloud auth print-identity-token', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (err) {
    console.error('Failed to get gcloud token:', err.message);
    return '';
  }
}

async function benchmarkModel() {
  console.log('⚡ Profiling Model Speed & Performance for:', MODEL_NAME);
  console.log('🌐 Endpoint:', CLOUD_RUN_URL);

  const token = getAuthToken();
  if (!token) {
    console.error('No IAM token available');
    process.exit(1);
  }

  const client = new OpenAI({
    baseURL: CLOUD_RUN_URL,
    apiKey: token,
    defaultHeaders: {
      Authorization: `Bearer ${token}`
    }
  });

  const testPrompts = [
    { type: 'Direct Policy', prompt: 'What are your Saturday branch opening hours at PlaceMakers?' },
    { type: 'Direct Technical', prompt: 'What joist span is allowed for 140x45 SG8 timber under NZS 3604?' },
    { type: 'Tool Call (Search)', prompt: 'What screws are required for treated timber decking in a sea spray zone?' },
    { type: 'Tool Call (Stock)', prompt: 'Do you have Kwila decking in stock at Mt Wellington?' },
    { type: 'Multi-Step Planning', prompt: 'I want to build a 4m x 3m Kwila deck under 1 meter high in Auckland.' }
  ];

  const results = [];

  for (let i = 0; i < testPrompts.length; i++) {
    const { type, prompt } = testPrompts[i];
    console.log(`\n[${i + 1}/${testPrompts.length}] Testing "${type}"...`);
    console.log(`💬 Prompt: "${prompt}"`);

    const tStart = Date.now();
    let tFirstToken = 0;
    let tokenCount = 0;
    let fullText = '';

    const stream = await client.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        {
          role: 'system',
          content: 'You are the PlaceMakers Trade Assistant AI. If you need catalogue info, use searchKnowledge. If checking inventory, use checkBranchStock. If answering policy, answer directly.'
        },
        { role: 'user', content: prompt }
      ],
      stream: true,
      max_tokens: 300,
      temperature: 0.2
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        if (!tFirstToken) {
          tFirstToken = Date.now();
        }
        tokenCount++;
        fullText += delta;
      }
    }

    const tEnd = Date.now();
    const ttft = tFirstToken ? tFirstToken - tStart : tEnd - tStart;
    const generationTime = tEnd - (tFirstToken || tStart);
    const totalTime = tEnd - tStart;
    const tokensPerSec = generationTime > 0 ? ((tokenCount / generationTime) * 1000).toFixed(1) : 'N/A';

    console.log(`  ⏱️  TTFT (Time to First Token): ${ttft} ms`);
    console.log(`  🚀 Decode Speed:              ${tokensPerSec} tokens/sec (${tokenCount} tokens in ${generationTime} ms)`);
    console.log(`  🕒 Total Latency:             ${totalTime} ms`);
    console.log(`  📝 Output snippet:            "${fullText.slice(0, 100).replace(/\n/g, ' ')}..."`);

    results.push({
      type,
      prompt,
      ttft,
      generationTime,
      totalTime,
      tokenCount,
      tokensPerSec: parseFloat(tokensPerSec) || 0,
      outputSnippet: fullText.slice(0, 120)
    });
  }

  // Summary Metrics
  const avgTTFT = Math.round(results.reduce((a, b) => a + b.ttft, 0) / results.length);
  const avgTotal = Math.round(results.reduce((a, b) => a + b.totalTime, 0) / results.length);
  const avgTPS = (results.reduce((a, b) => a + b.tokensPerSec, 0) / results.length).toFixed(1);

  console.log('\n================================================================');
  console.log('📊 MODEL SPEED & PERFORMANCE SUMMARY');
  console.log('================================================================');
  console.log(`Model:                     ${MODEL_NAME}`);
  console.log(`GPU Infrastructure:        NVIDIA L4 (24GB VRAM) on Google Cloud Run`);
  console.log(`Average TTFT:              ${avgTTFT} ms`);
  console.log(`Average Generation Speed:  ${avgTPS} tokens/sec`);
  console.log(`Average E2E Latency:       ${avgTotal} ms`);
  console.log('================================================================\n');

  return { results, avgTTFT, avgTotal, avgTPS };
}

benchmarkModel().catch(err => {
  console.error('Error profiling model:', err);
  process.exit(1);
});
