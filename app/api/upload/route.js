// app/api/upload/route.js
// Image upload handler — converts to base64, sends to orchestrator OCR

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { extractSlipFromImage } from '@/server/ai/orchestrator';

export const config = { api: { bodyParser: false } };

export async function POST(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const formData = await request.formData();
    const file = formData.get('image');

    if (!file) return NextResponse.json({ error: 'No image provided' }, { status: 400 });

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json({ error: 'Invalid file type. Use JPEG, PNG, or WebP' }, { status: 400 });
    }

    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large. Max 5MB' }, { status: 400 });
    }

    // Convert to base64
    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    // Extract matches via Claude vision
    const matches = await extractSlipFromImage(base64, file.type);

    if (!matches || matches.length === 0) {
      return NextResponse.json({ error: 'No bet selections could be extracted from image' }, { status: 422 });
    }

    return NextResponse.json({
      success: true,
      matches,
      extractedCount: matches.length,
      imageBase64: base64,
      mimeType: file.type,
    });

  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
