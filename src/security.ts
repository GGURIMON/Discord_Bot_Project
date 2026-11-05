export async function verifySignature(request: Request, raw: string, publicKey: string, now = Date.now()): Promise<boolean> {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature) || !/^[0-9a-f]{64}$/i.test(publicKey) || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > 300000) return false;
  const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, value => parseInt(value, 16));
  try {
    const key = await crypto.subtle.importKey('raw', bytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bytes(signature), new TextEncoder().encode(timestamp + raw));
  } catch { return false; }
}
