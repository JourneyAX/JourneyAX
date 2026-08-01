import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL,
    NEXT_PUBLIC_AUTH_API: process.env.NEXT_PUBLIC_AUTH_API,
    GATEWAY_URL: process.env.GATEWAY_URL,
    NEXT_PUBLIC_GATEWAY_API: process.env.NEXT_PUBLIC_GATEWAY_API,
  });
}
