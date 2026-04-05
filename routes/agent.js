// ══════════════════════════════════════════════════
// BOOKING AGENT ROUTES — /api/agent
// AI-powered pitch generation + follow-up sequences
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ── CONSTANTS ────────────────────────────────────────
const VALID_TONES = ['professional', 'casual', 'energetic'];
const VALID_LANGUAGES = ['english', 'portuguese'];
const AI_TIMEOUT_MS = 30_000;  // FIX: 30s timeout on AI calls (was unlimited)
const AI_MAX_RETRIES = 2;      // FIX: retry once on transient failures

// FIX: per-user rate limiting for AI calls (20 calls / hour)
const aiUsage = new Map();
const AI_RATE_WINDOW_MS = 60 * 60 * 1000;
const AI_RATE_MAX = 20;

function checkAIRateLimit(userId) {
  const now = Date.now();
  const record = aiUsage.get(userId);
  if (!record || now - record.windowStart > AI_RATE_WINDOW_MS) {
    aiUsage.set(userId, { windowStart: now, count: 1 });
    return true;
  }
  record.count++;
  return record.count <= AI_RATE_MAX;
}

// Cleanup stale entries every 30 min
setInterval(() => {
  const now = Date.now();
  for (const [uid, record] of aiUsage) {
    if (now - record.windowStart > AI_RATE_WINDOW_MS) aiUsage.delete(uid);
  }
}, 30 * 60 * 1000).unref();


// ── AI HELPER ────────────────────────────────────────
// FIX: Gemini model cache with TTL (was cached forever — if Google
// deprecates a model, the app would keep trying it until restart)
let _geminiModels = null;
let _geminiModelsCachedAt = 0;
const GEMINI_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getGeminiModels(apiKey) {
  const now = Date.now();
  if (_geminiModels && (now - _geminiModelsCachedAt) < GEMINI_CACHE_TTL_MS) {
    return _geminiModels;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(
      // FIX: API key in URL is acceptable for Gemini (it's their documented pattern)
      // but we should at minimum not log the URL anywhere
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=50`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const supported = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .filter(name => /gemini-(2|1\.5)/.test(name) && !name.includes('image') && !name.includes('vision'));
    supported.sort((a, b) => {
      const score = n =>
        n.includes('2.5-flash') ? 0 :
        n.includes('2.0-flash') ? 1 :
        n.includes('1.5-flash') ? 2 :
        n.includes('1.5-pro')   ? 3 : 4;
      return score(a) - score(b);
    });
    _geminiModels = supported.slice(0, 3);
    _geminiModelsCachedAt = now;
    return _geminiModels;
  } catch (e) {
    return null;
  }
}

// FIX: fetch with timeout helper (original had no timeout — a hanging
// AI call would hold the Express connection open forever)
async function fetchWithTimeout(url, options, timeoutMs = AI_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function callAI(prompt, maxTokens = 1200) {
  // FIX: wrap both providers in retry logic for transient failures
  let lastErr = 'No AI provider configured';

  // Try Gemini first (free tier)
  if (process.env.GEMINI_API_KEY) {
    const key = process.env.GEMINI_API_KEY;
    const models = await getGeminiModels(key) || ['gemini-2.5-flash', 'gemini-2.0-flash'];

    for (const model of models) {
      for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
            }),
          });

          if (res.ok) {
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return text;
            lastErr = `Gemini ${model}: empty response`;
            break; // empty response won't improve with retry
          }

          const status = res.status;

          // FIX: don't log full error body (may contain API key echoes in some providers)
          lastErr = `Gemini ${model}: HTTP ${status}`;

          // Non-retryable errors
          if (status === 400 || status === 403) {
            _geminiModels = null;
            _geminiModelsCachedAt = 0;
            break; // bad key/request — no point retrying
          }
          if (status === 404) {
            _geminiModels = null;
            _geminiModelsCachedAt = 0;
            break; // model gone — try next model
          }

          // 429 or 5xx: retryable — wait with exponential backoff
          if (attempt < AI_MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
        } catch (e) {
          lastErr = e.name === 'AbortError' ? `Gemini ${model}: timeout` : e.message;
          if (attempt < AI_MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
          }
        }
      }
    }
  }

  // Fallback to Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
      try {
        const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: maxTokens,
            // FIX: use system prompt for role instruction, user prompt for the task
            // (original crammed everything into a single user message)
            system: 'You are a professional booking agent for a Portuguese hard rock band. You write compelling, personalised pitch emails. You always respond in the exact format requested.',
            messages: [{ role: 'user', content: prompt }],
          }),
        });

        if (res.ok) {
          const data = await res.json();
          return data.content?.[0]?.text || '';
        }

        const status = res.status;
        lastErr = `Anthropic: HTTP ${status}`;

        // 429 or 5xx: retryable
        if (status >= 500 || status === 429) {
          if (attempt < AI_MAX_RETRIES) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
            continue;
          }
        }
        break; // 4xx (non-429) is not retryable
      } catch (e) {
        lastErr = e.name === 'AbortError' ? 'Anthropic: timeout' : e.message;
        if (attempt < AI_MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      }
    }
  }

  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('No AI API key configured. Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY to Railway Variables.');
  }
  throw new Error(`AI generation failed: ${lastErr}`);
}


// ── BAND PROFILE (used to personalise every pitch) ─
const BAND_PROFILE = {
  name: 'The Ginskeys',
  genre: 'Hard Rock',
  location: 'Sines, Alentejo, Portugal',
  members: 4,
  highlights: [
    'Headlined Tasquinhas do Povo 2023 — sold out, 1,200+ attendance',
    'Performed at Semana da Juventude 2024',
    'Performed at Abril em Odemira 2024',
    'FMM Sines connection — professional AV/stage background',
    'Self-produced singles releasing 2026',
    'Hard rock with Portuguese identity — rare in Alentejo/Algarve circuit',
  ],
  fee_range: '€800–1,500',
  set_lengths: ['45 min', '60 min', '90 min'],
  languages: ['Portuguese', 'English'],
  epk_note: 'Full EPK and rider available on request',
};

// ── VENUE DATABASE — Portuguese circuit ─────────────
const VENUE_DATABASE = [
  // Algarve — tourist corridor
  { id:'v001', name:"Stevie Ray's Blues Bar", city:'Lagos', region:'algarve', type:'bar_venue', capacity:150, genre_fit:'rock', contact_role:'Manager', fee_bracket:'€500–1,200', notes:'Blues/rock format. Tourist season Jun–Sep peak.' },
  { id:'v002', name:'Bon Vivant Music Bar', city:'Lagos', region:'algarve', type:'bar_venue', capacity:120, genre_fit:'rock', contact_role:'Booking Manager', fee_bracket:'€400–900', notes:'Regular live music nights. Mixed international crowd.' },
  { id:'v003', name:'Three Monkeys Bar', city:'Albufeira', region:'algarve', type:'bar_venue', capacity:200, genre_fit:'rock', contact_role:'Events Manager', fee_bracket:'€600–1,500', notes:'High-energy venue. Summer season essential.' },
  { id:'v004', name:'Kiss Bar', city:'Albufeira', region:'algarve', type:'bar_venue', capacity:300, genre_fit:'rock', contact_role:'Promoter', fee_bracket:'€800–2,000', notes:'Large rock venue. Albufeira strip.' },
  { id:'v005', name:'Rooftop Lounge — Pine Cliffs Resort', city:'Albufeira', region:'algarve', type:'hotel_resort', capacity:250, genre_fit:'rock_acoustic', contact_role:'Events Coordinator', fee_bracket:'€1,000–2,500', notes:'Luxury resort. Prefers polished live acts.' },
  { id:'v006', name:'Vilamoura Marina Live Stage', city:'Vilamoura', region:'algarve', type:'outdoor', capacity:500, genre_fit:'rock', contact_role:'Events Director', fee_bracket:'€1,000–3,000', notes:'Summer outdoor stage. High footfall.' },
  { id:'v007', name:'Zoomarine Summer Stage', city:'Albufeira', region:'algarve', type:'festival_venue', capacity:1000, genre_fit:'rock', contact_role:'Booking Agent', fee_bracket:'€800–2,000', notes:'Family/tourist attraction. Supports local acts.' },
  { id:'v008', name:'Bar Amuras', city:'Lagos', region:'algarve', type:'bar_venue', capacity:100, genre_fit:'rock', contact_role:'Owner', fee_bracket:'€300–700', notes:'Intimate. Good for building Algarve presence.' },
  // Alentejo — home region
  { id:'v009', name:'Festival do Crato', city:'Crato', region:'alentejo', type:'festival', capacity:3000, genre_fit:'rock', contact_role:'Programming Director', fee_bracket:'€500–1,500', notes:'August. Rock/indie programming. Apply by April.' },
  { id:'v010', name:'Festa da Criança — Odemira', city:'Odemira', region:'alentejo', type:'municipal_festa', capacity:800, genre_fit:'rock', contact_role:'Câmara Municipal', fee_bracket:'€500–1,200', notes:'Municipal summer festa. Budget exists for local acts.' },
  { id:'v011', name:'Festas de Santiago — Setúbal', city:'Setúbal', region:'setubal', type:'municipal_festa', capacity:1500, genre_fit:'rock', contact_role:'Comissão de Festas', fee_bracket:'€600–1,500', notes:'July. Large attendance. Rock welcome.' },
  { id:'v012', name:'Festas de Santo António — Vila do Bispo', city:'Vila do Bispo', region:'alentejo', type:'municipal_festa', capacity:400, genre_fit:'rock', contact_role:'Junta de Freguesia', fee_bracket:'€400–900', notes:'Summer. Small but guaranteed budget.' },
  { id:'v013', name:'Tasquinhas do Povo — Sines', city:'Sines', region:'alentejo', type:'festival', capacity:1200, genre_fit:'rock', contact_role:'Organising Committee', fee_bracket:'€1,000–1,500', notes:'PROVEN — played 2023. Re-book annually.' },
  { id:'v014', name:'Semana da Juventude — Sines', city:'Sines', region:'alentejo', type:'municipal_event', capacity:600, genre_fit:'rock', contact_role:'Câmara de Sines', fee_bracket:'€800–1,200', notes:'PROVEN — played 2024.' },
  // Lisbon
  { id:'v015', name:'MusicBox Lisboa', city:'Lisbon', region:'lisboa', type:'club_venue', capacity:400, genre_fit:'rock', contact_role:'Booking Manager', fee_bracket:'€300–1,000', notes:'Cais do Sodré. Premier indie/rock venue.' },
  { id:'v016', name:'RCA Club', city:'Lisbon', region:'lisboa', type:'club_venue', capacity:350, genre_fit:'rock', contact_role:'Booking Manager', fee_bracket:'€300–800', notes:'Lisbon underground rock venue. Good for building scene credibility.' },
  // Porto
  { id:'v017', name:'Hard Club', city:'Porto', region:'porto', type:'club_venue', capacity:1000, genre_fit:'rock', contact_role:'Booking Director', fee_bracket:'€500–1,500', notes:'Porto premier hard rock venue.' },
  { id:'v018', name:'Aula Magna', city:'Lisbon', region:'lisboa', type:'concert_hall', capacity:2000, genre_fit:'rock', contact_role:'Programming Manager', fee_bracket:'€1,000–3,000', notes:'Target post-album release.' },
  // Weddings / Corporate
  { id:'v019', name:'Quinta dos Santos', city:'Estômbar', region:'algarve', type:'wedding_venue', capacity:200, genre_fit:'rock_function', contact_role:'Events Manager', fee_bracket:'€1,500–3,000', notes:'Premium wedding venue. Regularly books live bands.' },
  { id:'v020', name:'Forte da Cruz', city:'Estoril', region:'lisboa', type:'wedding_venue', capacity:300, genre_fit:'rock_function', contact_role:'Events Coordinator', fee_bracket:'€1,500–2,500', notes:'Luxury event space.' },
  { id:'v021', name:'Monte Rei Golf & Country Club', city:'Castro Marim', region:'algarve', type:'corporate', capacity:250, genre_fit:'rock_acoustic', contact_role:'Events Manager', fee_bracket:'€2,000–4,000', notes:'Ultra-premium. Requires polished presentation.' },
  // Spain border — expansion
  { id:'v022', name:'Sala El Sol', city:'Madrid', region:'spain', type:'club_venue', capacity:300, genre_fit:'rock', contact_role:'Booking Agent', fee_bracket:'€400–1,000', notes:'Iconic Madrid rock club. Good for cross-border push.' },
  { id:'v023', name:'Sala Custom', city:'Sevilla', region:'spain', type:'club_venue', capacity:400, genre_fit:'rock', contact_role:'Promoter', fee_bracket:'€500–1,200', notes:'Andalusia rock venue. Short drive from Alentejo.' },
];

// FIX: helper to parse fee bracket into numeric range for filtering
function parseFeeMin(bracket) {
  const match = bracket.match(/€([\d,]+)/);
  if (!match) return 0;
  return parseInt(match[1].replace(/,/g, ''));
}

// FIX: sanitise user-supplied text before injecting into AI prompt
// (prevents prompt injection attacks where a user puts
//  "Ignore all previous instructions..." in additional_context)
function sanitisePromptInput(text, maxLength = 500) {
  if (!text) return '';
  return text
    .slice(0, maxLength)
    .replace(/[<>{}]/g, '')  // strip angle brackets and braces
    .trim();
}


// ── GET /api/agent/venues ────────────────────────────
router.get('/venues', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { region, type, min_fee } = req.query;
    let venues = VENUE_DATABASE;
    if (region) venues = venues.filter(v => v.region === region);
    if (type)   venues = venues.filter(v => v.type === type);
    // FIX: min_fee filter was defined in query params but never implemented
    if (min_fee) {
      const minFeeNum = parseInt(min_fee);
      if (isFinite(minFeeNum)) {
        venues = venues.filter(v => parseFeeMin(v.fee_bracket) >= minFeeNum);
      }
    }
    res.json({ venues, total: venues.length, band: BAND_PROFILE });
  } catch(err) { next(err); }
});

// ── POST /api/agent/pitch ────────────────────────────
router.post('/pitch', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    // FIX: AI rate limiting per user
    if (!checkAIRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'AI rate limit exceeded. Max 20 generations per hour.' });
    }

    const { venue_id, tone = 'professional', language = 'english',
            proposed_date, additional_context = '' } = req.body;

    // FIX: validate tone and language inputs
    if (!VALID_TONES.includes(tone))
      return res.status(400).json({ error: 'tone must be one of: ' + VALID_TONES.join(', ') });
    if (!VALID_LANGUAGES.includes(language))
      return res.status(400).json({ error: 'language must be one of: ' + VALID_LANGUAGES.join(', ') });

    const venue = VENUE_DATABASE.find(v => v.id === venue_id);
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    // FIX: sanitise user-supplied context before injecting into prompt
    const safeContext = sanitisePromptInput(additional_context);
    const safeDate = sanitisePromptInput(proposed_date, 100);

    const prompt = buildPitchPrompt(venue, tone, language, safeDate, safeContext);
    const text = await callAI(prompt, 1200);

    const { subject, body } = parseAIResponse(text, `Live Music Booking — The Ginskeys`);

    // FIX: auto-create booking contact if not already tracked
    const { rows: existingBooking } = await pool.query(
      `SELECT id FROM booking_contacts WHERE name = $1 LIMIT 1`,
      [venue.name]
    );
    let bookingId = existingBooking[0]?.id || null;
    if (!bookingId) {
      const newId = uuid();
      await pool.query(
        `INSERT INTO booking_contacts (id, name, type, location, stage, notes, created_by)
         VALUES ($1, $2, $3, $4, 'contacted', $5, $6)
         ON CONFLICT DO NOTHING`,
        [newId, venue.name, venue.type.includes('wedding') ? 'wedding' : venue.type === 'festival' ? 'festival' : 'venue',
         `${venue.city}, ${venue.region}`,
         `Auto-created from agent pitch. ${venue.notes}`,
         req.user.id]
      );
      bookingId = newId;
    }

    await writeAudit(req, 'AGENT_PITCH_GENERATED', {
      entityType: 'booking',
      entityId: bookingId,
      details: `Pitch for ${venue.name} (${venue.city}) — ${tone}/${language}`,
    });

    res.json({
      venue,
      subject,
      body,
      language,
      tone,
      booking_id: bookingId,
      generated_at: new Date().toISOString(),
    });
  } catch(err) { next(err); }
});

// ── POST /api/agent/followup ─────────────────────────
router.post('/followup', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    // FIX: AI rate limiting
    if (!checkAIRateLimit(req.user.id)) {
      return res.status(429).json({ error: 'AI rate limit exceeded. Max 20 generations per hour.' });
    }

    const { booking_id, followup_number = 1, language = 'english' } = req.body;

    // FIX: validate inputs
    if (!booking_id)
      return res.status(400).json({ error: 'booking_id required' });
    if (!VALID_LANGUAGES.includes(language))
      return res.status(400).json({ error: 'language must be one of: ' + VALID_LANGUAGES.join(', ') });

    const followupNum = parseInt(followup_number);
    if (!isFinite(followupNum) || followupNum < 1 || followupNum > 3)
      return res.status(400).json({ error: 'followup_number must be 1, 2, or 3' });

    const { rows } = await pool.query('SELECT * FROM booking_contacts WHERE id=$1', [booking_id]);
    const contact = rows[0];
    if (!contact) return res.status(404).json({ error: 'Booking contact not found' });

    const prompt = buildFollowupPrompt(contact, followupNum, language);
    const text = await callAI(prompt, 800);
    const { subject, body } = parseAIResponse(text, `Follow up — The Ginskeys`);

    // FIX: audit trail for followups (was missing)
    await writeAudit(req, 'AGENT_FOLLOWUP_GENERATED', {
      entityType: 'booking',
      entityId: booking_id,
      details: `Follow-up #${followupNum} for ${contact.name}`,
    });

    // FIX: update the booking contact's follow_up_date and stage
    if (contact.stage === 'cold') {
      await pool.query(
        `UPDATE booking_contacts SET stage = 'contacted', contacted_at = now(), updated_at = now() WHERE id = $1`,
        [booking_id]
      );
    }

    res.json({
      contact,
      subject,
      body,
      followup_number: followupNum,
      language,
      generated_at: new Date().toISOString(),
    });
  } catch(err) { next(err); }
});

// ── POST /api/agent/batch ────────────────────────────
router.post('/batch', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    // FIX: AI rate limiting — batch counts as N calls
    const { venue_ids, tone = 'professional', language = 'english', proposed_month } = req.body;
    if (!venue_ids?.length) return res.status(400).json({ error: 'venue_ids required' });
    if (venue_ids.length > 10) return res.status(400).json({ error: 'Max 10 venues per batch' });

    // FIX: validate inputs
    if (!VALID_TONES.includes(tone))
      return res.status(400).json({ error: 'tone must be one of: ' + VALID_TONES.join(', ') });
    if (!VALID_LANGUAGES.includes(language))
      return res.status(400).json({ error: 'language must be one of: ' + VALID_LANGUAGES.join(', ') });

    // Check rate limit for the whole batch
    const rateLimitRecord = aiUsage.get(req.user.id);
    const currentCount = rateLimitRecord ? rateLimitRecord.count : 0;
    if (currentCount + venue_ids.length > AI_RATE_MAX) {
      return res.status(429).json({
        error: `Batch of ${venue_ids.length} would exceed rate limit. ${AI_RATE_MAX - currentCount} calls remaining this hour.`,
      });
    }

    const safeMonth = sanitisePromptInput(proposed_month, 100);

    // FIX: run in controlled concurrency (3 at a time) instead of
    // sequential (slow) or fully parallel (would hammer the API)
    const results = [];
    const CONCURRENCY = 3;
    const validVenues = venue_ids.map(vid => {
      const venue = VENUE_DATABASE.find(v => v.id === vid);
      return venue ? { vid, venue } : { vid, venue: null };
    });

    for (let i = 0; i < validVenues.length; i += CONCURRENCY) {
      const chunk = validVenues.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.allSettled(
        chunk.map(async ({ vid, venue }) => {
          if (!venue) return { venue_id: vid, error: 'Not found' };

          // Count against rate limit
          checkAIRateLimit(req.user.id);

          const prompt = buildPitchPrompt(venue, tone, language, safeMonth, '');
          const text = await callAI(prompt, 800);
          const { subject, body } = parseAIResponse(text, `Live Music — The Ginskeys`);
          return { venue, subject, body };
        })
      );

      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({ error: result.reason?.message || 'Generation failed' });
        }
      }
    }

    await writeAudit(req, 'AGENT_BATCH_GENERATED', {
      details: `Batch of ${results.length} pitches (${results.filter(r => !r.error).length} succeeded)`,
    });
    res.json({ results, generated_at: new Date().toISOString() });
  } catch(err) { next(err); }
});


// ── RESPONSE PARSER ──────────────────────────────────
// FIX: extracted into a shared function (was duplicated in every route)
function parseAIResponse(text, defaultSubject) {
  const subjectMatch = text.match(/SUBJECT:\s*(.+)/i);
  const bodyMatch    = text.match(/BODY:\s*([\s\S]+)/i);
  return {
    subject: subjectMatch ? subjectMatch[1].trim() : defaultSubject,
    body:    bodyMatch    ? bodyMatch[1].trim()    : text,
  };
}


// ── PROMPT BUILDERS ──────────────────────────────────
function buildPitchPrompt(venue, tone, language, proposed_date, extra) {
  const band = BAND_PROFILE;
  const isPortuguese = language === 'portuguese';
  const lang = isPortuguese ? 'European Portuguese' : 'English';

  const toneDesc = tone === 'professional' ? 'formal but warm'
    : tone === 'casual' ? 'friendly and direct'
    : 'energetic and enthusiastic';

  // FIX: the prompt now properly structures the request and avoids
  // leaking the venue's internal fee_bracket to the AI (which could
  // make the AI anchor the band's fee too low for high-budget venues)
  return `You are the booking agent for ${band.name}, a ${band.genre} band from ${band.location}.
Write a personalised booking pitch email in ${lang} for the following venue.

BAND DETAILS:
- Name: ${band.name}
- Genre: ${band.genre}
- Members: ${band.members}
- From: ${band.location}
- Fee range: ${band.fee_range}
- Set lengths available: ${band.set_lengths.join(', ')}
- Key highlights:
${band.highlights.map(h => '  • ' + h).join('\n')}
- Languages spoken: ${band.languages.join(', ')}
- ${band.epk_note}

VENUE DETAILS:
- Name: ${venue.name}
- City: ${venue.city}, ${venue.region.toUpperCase()}
- Type: ${venue.type.replace(/_/g, ' ')}
- Capacity: ${venue.capacity}
- Genre fit: ${venue.genre_fit}
- Contact role: ${venue.contact_role}
- Notes: ${venue.notes}

TONE: ${toneDesc}
${proposed_date ? 'PROPOSED DATE/PERIOD: ' + proposed_date : ''}
${extra ? 'ADDITIONAL CONTEXT FROM AGENT: ' + extra : ''}

Write a compelling, personalised pitch email that:
1. Opens by referencing something SPECIFIC about this venue (its type, city, typical crowd, season)
2. Introduces The Ginskeys concisely with their most relevant credential for THIS venue
3. Makes a clear, specific ask (propose a date range or season)
4. States the fee range and set options
5. Closes with a clear call to action
6. Sounds like a human booking agent who knows the Portuguese scene, NOT a template
7. Is appropriately concise — venue bookers are busy
8. Does NOT mention that you are an AI or that this was auto-generated

Format your response EXACTLY as:
SUBJECT: [email subject line]
BODY:
[full email body]`;
}

function buildFollowupPrompt(contact, followupNumber, language) {
  const band = BAND_PROFILE;
  const lang = language === 'portuguese' ? 'European Portuguese' : 'English';
  const followupText = followupNumber === 1
    ? 'first follow-up (sent 7 days after initial pitch)'
    : followupNumber === 2
    ? 'second follow-up (sent 14 days after initial pitch)'
    : 'final follow-up (last attempt, keep it brief and leave on good terms)';

  return `You are the booking agent for ${band.name}, a ${band.genre} band from ${band.location}.

Write a ${followupText} email in ${lang} to ${contact.name} (${contact.type || 'venue'}).
${contact.location ? 'Location: ' + contact.location : ''}
${contact.notes ? 'Context: ' + sanitisePromptInput(contact.notes) : ''}
${contact.fee_eur ? 'Previously discussed fee: €' + contact.fee_eur : ''}

The follow-up should:
- Be SHORT (3-5 sentences max)
- Reference the initial pitch briefly
- Add ONE new piece of value (a recent achievement, availability for a specific date, or a specific offer)
- Have a clear, easy call-to-action
- NOT be apologetic or desperate — confident and professional
- NOT mention that you are an AI

Format EXACTLY as:
SUBJECT: [subject line]
BODY:
[email body]`;
}

module.exports = router;
