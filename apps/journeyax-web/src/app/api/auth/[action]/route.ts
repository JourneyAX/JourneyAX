/**
 * Auth API Proxy Routes
 * Proxies login/register/refresh/logout from browser → API Gateway → auth-service
 * The browser never calls the gateway directly — all auth flows through here.
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3010';

async function proxyAuth(req: Request, path: string): Promise<Response> {
  const body = await req.json();

  const res = await fetch(`${GATEWAY_URL}/api/v1/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ action: string }> }
) {
  const { action } = await params;

  const allowedActions = ['login', 'register', 'refresh', 'logout', 'verify'];
  if (!allowedActions.includes(action)) {
    return new Response(JSON.stringify({ error: 'Invalid auth action' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    return await proxyAuth(req, action);
  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: 'Auth service unavailable', message: error.message }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
