// ══════════════════════════════════════════════════
// BOOKING AGENT ROUTES — /api/agent
// AI-powered pitch generation + follow-up sequences
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ── AI HELPER — Gemini (free tier) ──────────────────
async function callAI(prompt, maxTokens = 1200) {
  // Try Gemini first (free tier — 1,500 calls/day)
  if (process.env.GEMINI_API_KEY) {
    // Try models in order until one works
    const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-latest', 'gemini-pro'];
    let lastErr = 'No model worked';
    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const res = await fetch(url, {
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
        }
        const errBody = await res.text().catch(() => '');
        lastErr = `Gemini ${model} ${res.status}: ${errBody.slice(0, 150)}`;
        // 400/403 = bad key or bad request, no point retrying other models
        if (res.status === 400 || res.status === 403) break;
      } catch(e) { lastErr = e.message; }
    }
    throw new Error(lastErr);
  }

  // Fallback to Anthropic if key present
  if (process.env.ANTHROPIC_API_KEY) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic error: ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  throw new Error('No AI API key configured. Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY to Railway Variables.');
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
// Curated list of real venues + festival types on the circuit
const VENUE_DATABASE = [
  // Algarve — tourist corridor
  { id:'v001', name:"Stevie Ray's Blues Bar", city:'Lagos', region:'algarve', type:'bar_venue', capacity:150, genre_fit:'rock', contact_role:'Manager', fee_bracket:'€500–1200', notes:'Blues/rock format. Tourist season Jun–Sep peak.' },
  { id:'v002', name:'Bon Vivant Music Bar', city:'Lagos', region:'algarve', type:'bar_venue', capacity:120, genre_fit:'rock', contact_role:'Booking Manager', fee_bracket:'€400–900', notes:'Regular live music nights. Mixed international crowd.' },
  { id:'v003', name:'Three Monkeys Bar', city:'Albufeira', region:'algarve', type:'bar_venue', capacity:200, genre_fit:'rock', contact_role:'Events Manager', fee_bracket:'€600–1500', notes:'High-energy venue. Summer season essential.' },
  { id:'v004', name:'Kiss Bar', city:'Albufeira', region:'algarve', type:'bar_venue', capacity:300, genre_fit:'rock', contact_role:'Promoter', fee_bracket:'€800–2000', notes:'Large rock venue. Albufeira strip.' },
  { id:'v005', name:'Rooftop Lounge — Pine Cliffs Resort', city:'Albufeira', region:'algarve', type:'hotel_resort', capacity:250, genre_fit:'rock_acoustic', contact_role:'Events Coordinator', fee_bracket:'€1000–2500', notes:'Luxury resort. Prefers polished live acts.' },
  { id:'v006', name:'Vilamoura Marina live stage', city:'Vilamoura', region:'algarve', type:'outdoor', capacity:500, genre_fit:'rock', contact_role:'Events Director', fee_bracket:'€1000–3000', notes:'Summer outdoor stage. High footfall.' },
  { id:'v007', name:'Zoomarine Summer Stage', city:'Albufeira', region:'algarve', type:'festival_venue', capacity:1000, genre_fit:'rock', contact_role:'Booking Agent', fee_bracket:'€800–2000', notes:'Family/tourist attraction. Supports local acts.' },
  { id:'v008', name:'Bar Amuras', city:'Lagos', region:'algarve', type:'bar_venue', capacity:100, genre_fit:'rock', contact_role:'Owner', fee_bracket:'€300–700', notes:'Intimate. Good for building Algarve presence.' },
  // Alentejo — home region
  { id:'v009', name:'Festival do Crato', city:'Crato', region:'alentejo', type:'festival', capacity:3000, genre_fit:'rock', contact_role:'Programming Director', fee_bracket:'€500–1500', notes:'August. Rock/indie programming. Apply by April.' },
  { id:'v010', name:'Festa da Criança — Odemira', city:'Odemira', region:'alentejo', type:'municipal_festa', capacity:800, genre_fit:'rock', contact_role:'Câmara Municipal', fee_bracket:'€500–1200', notes:'Municipal summer festa. Budget exists for local acts.' },
  { id:'v011', name:'Festas de Santiago — Setúbal', city:'Setúbal', region:'setubal', type:'municipal_festa', capacity:1500, genre_fit:'rock', contact_role:'Comissão de Festas', fee_bracket:'€600–1500', notes:'July. Large attendance. Rock welcome.' },
  { id:'v012', name:'Festas de Santo António — Vila do Bispo', city:'Vila do Bispo', region:'alentejo', type:'municipal_festa', capacity:400, genre_fit:'rock', contact_role:'Junta de Freguesia', fee_bracket:'€400–900', notes:'Summer. Small but guaranteed budget.' },
  { id:'v013', name:'Tasquinhas do Povo — Sines', city:'Sines', region:'alentejo', type:'festival', capacity:1200, genre_fit:'rock', contact_role:'Organising Committee', fee_bracket:'€1000–1500', notes:'PROVEN — played 2023. Re-book annually.' },
  { id:'v014', name:'Semana da Juventude — Sines', city:'Sines', region:'alentejo', type:'municipal_event', capacity:600, genre_fit:'rock', contact_role:'Câmara de Sines', fee_bracket:'€800–1200', notes:'PROVEN — played 2024.' },
  // Lisbon
  { id:'v015', name:'Music Box Lisboa', city:'Lisbon', region:'lisboa', type:'club_venue', capacity:400, genre_fit:'rock', contact_role:'Booking Manager', fee_bracket:'€300–800', notes:'Cais do Sodré. Premier indie/rock venue.' },
  { id:'v016', name:'Musicbox Lisboa', city:'Lisbon', region:'lisboa', type:'club_venue', capacity:500, genre_fit:'rock', contact_role:'Promoter', fee_bracket:'€400–1000', notes:'Key Lisbon rock venue. Needs press/streaming presence.' },
  { id:'v017', name:'Hard Club', city:'Porto', region:'porto', type:'club_venue', capacity:1000, genre_fit:'rock', contact_role:'Booking Director', fee_bracket:'€500–1500', notes:'Porto premier hard rock venue.' },
  { id:'v018', name:'Aula Magna', city:'Lisbon', region:'lisboa', type:'concert_hall', capacity:2000, genre_fit:'rock', contact_role:'Programming Manager', fee_bracket:'€1000–3000', notes:'Target post-album release.' },
  // Weddings / Corporate — Algarve
  { id:'v019', name:'Quinta dos Santos', city:'Estômbar', region:'algarve', type:'wedding_venue', capacity:200, genre_fit:'rock_function', contact_role:'Events Manager', fee_bracket:'€1500–3000', notes:'Premium wedding venue. Regularly books live bands.' },
  { id:'v020', name:'Forte da Cruz', city:'Estoril', region:'lisboa', type:'wedding_venue', capacity:300, genre_fit:'rock_function', contact_role:'Events Coordinator', fee_bracket:'€1500–2500', notes:'Luxury event space.' },
  { id:'v021', name:'Monte Rei Golf & Country Club', city:'Castro Marim', region:'algarve', type:'corporate', capacity:250, genre_fit:'rock_acoustic', contact_role:'Events Manager', fee_bracket:'€2000–4000', notes:'Ultra-premium. Requires polished presentation.' },
  // Spain border — expansion
  { id:'v022', name:'Sala El Sol', city:'Madrid', region:'spain', type:'club_venue', capacity:300, genre_fit:'rock', contact_role:'Booking Agent', fee_bracket:'€400–1000', notes:'Iconic Madrid rock club. Good for cross-border push.' },
  { id:'v023', name:'Sevilla Rock venues', city:'Sevilla', region:'spain', type:'club_venue', capacity:400, genre_fit:'rock', contact_role:'Promoter', fee_bracket:'€500–1200', notes:'Andalusia cross-border. Short drive from Alentejo.' },
];

// ── GET /api/agent/venues ────────────────────────────
// Returns filtered venue list
router.get('/venues', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { region, type, min_fee } = req.query;
    let venues = VENUE_DATABASE;
    if (region) venues = venues.filter(v => v.region === region);
    if (type)   venues = venues.filter(v => v.type === type);
    res.json({ venues, total: venues.length, band: BAND_PROFILE });
  } catch(err) { next(err); }
});

// ── POST /api/agent/pitch ────────────────────────────
// Generates AI pitch email for a specific venue
router.post('/pitch', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { venue_id, tone = 'professional', language = 'english',
            proposed_date, additional_context = '' } = req.body;

    const venue = VENUE_DATABASE.find(v => v.id === venue_id);
    if (!venue) return res.status(404).json({ error: 'Venue not found' });

    const prompt = buildPitchPrompt(venue, tone, language, proposed_date, additional_context);

    // Call AI (Gemini free tier or Anthropic fallback)
    const text = await callAI(prompt, 1200);

    // Parse subject and body
    const subjectMatch = text.match(/SUBJECT:\s*(.+)/i);
    const bodyMatch    = text.match(/BODY:\s*([\s\S]+)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : `Live Music Booking — The Ginskeys`;
    const body    = bodyMatch    ? bodyMatch[1].trim()    : text;

    // Log to booking_contacts if not already there
    await writeAudit(req, 'AGENT_PITCH_GENERATED', {
      entityType: 'booking',
      details: `Pitch generated for ${venue.name} (${venue.city})`,
    });

    res.json({ venue, subject, body, language, tone, generated_at: new Date().toISOString() });
  } catch(err) { next(err); }
});

// ── POST /api/agent/followup ─────────────────────────
// Generates follow-up email for existing booking contact
router.post('/followup', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { booking_id, followup_number = 1, language = 'english' } = req.body;

    const { rows } = await pool.query('SELECT * FROM booking_contacts WHERE id=$1', [booking_id]);
    const contact = rows[0];
    if (!contact) return res.status(404).json({ error: 'Booking contact not found' });

    const prompt = buildFollowupPrompt(contact, followup_number, language);

    const text = await callAI(prompt, 800);
    const subjectMatch = text.match(/SUBJECT:\s*(.+)/i);
    const bodyMatch    = text.match(/BODY:\s*([\s\S]+)/i);

    res.json({
      contact,
      subject: subjectMatch ? subjectMatch[1].trim() : `Follow up — The Ginskeys`,
      body: bodyMatch ? bodyMatch[1].trim() : text,
      followup_number,
    });
  } catch(err) { next(err); }
});

// ── POST /api/agent/batch ────────────────────────────
// Generate pitches for multiple venues in one call
router.post('/batch', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { venue_ids, tone = 'professional', language = 'english', proposed_month } = req.body;
    if (!venue_ids?.length) return res.status(400).json({ error: 'venue_ids required' });
    if (venue_ids.length > 10) return res.status(400).json({ error: 'Max 10 venues per batch' });

    const results = [];
    for (const vid of venue_ids) {
      const venue = VENUE_DATABASE.find(v => v.id === vid);
      if (!venue) { results.push({ venue_id: vid, error: 'Not found' }); continue; }

      const prompt = buildPitchPrompt(venue, tone, language, proposed_month, '');
      try {
        const text = await callAI(prompt, 800);
        const subjectMatch = text.match(/SUBJECT:\s*(.+)/i);
        const bodyMatch    = text.match(/BODY:\s*([\s\S]+)/i);
        results.push({
          venue,
          subject: subjectMatch ? subjectMatch[1].trim() : `Live Music — The Ginskeys`,
          body: bodyMatch ? bodyMatch[1].trim() : text,
        });
      } catch(e) {
        results.push({ venue, error: e.message });
      }
    }

    await writeAudit(req, 'AGENT_BATCH_GENERATED', {
      details: `Batch of ${results.length} pitches generated`,
    });
    res.json({ results, generated_at: new Date().toISOString() });
  } catch(err) { next(err); }
});

// ── PROMPT BUILDERS ──────────────────────────────────
function buildPitchPrompt(venue, tone, language, proposed_date, extra) {
  const band = BAND_PROFILE;
  const isPortuguese = language === 'portuguese';
  const lang = isPortuguese ? 'European Portuguese' : 'English';

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

VENUE DETAILS:
- Name: ${venue.name}
- City: ${venue.city}, ${venue.region.toUpperCase()}
- Type: ${venue.type.replace(/_/g,' ')}
- Capacity: ${venue.capacity}
- Genre fit: ${venue.genre_fit}
- Contact role: ${venue.contact_role}
- Typical fee bracket: ${venue.fee_bracket}
- Notes: ${venue.notes}

TONE: ${tone} (${tone === 'professional' ? 'formal but warm' : tone === 'casual' ? 'friendly and direct' : 'energetic and enthusiastic'})
${proposed_date ? 'PROPOSED DATE/PERIOD: ' + proposed_date : ''}
${extra ? 'ADDITIONAL CONTEXT: ' + extra : ''}

Write a compelling, personalised pitch email that:
1. Opens by referencing something SPECIFIC about this venue (its type, city, typical crowd, season)
2. Introduces The Ginskeys concisely with their most relevant credential for THIS venue
3. Makes a clear, specific ask (propose a date range or season)
4. States the fee range and set options
5. Closes with a clear call to action
6. Sounds like a human booking agent who knows the scene, NOT a template
7. Is appropriately concise — venue bookers are busy

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

Write a ${followupText} email in ${lang} to ${contact.name} (${contact.type}).
${contact.location ? 'Location: ' + contact.location : ''}
${contact.notes ? 'Context: ' + contact.notes : ''}

The follow-up should:
- Be SHORT (3-5 sentences max)
- Reference the initial pitch briefly
- Add ONE new piece of value (a recent achievement, availability for a specific date, or a specific offer)
- Have a clear, easy call-to-action
- NOT be apologetic or desperate — confident and professional

Format EXACTLY as:
SUBJECT: [subject line]
BODY:
[email body]`;
}

module.exports = router;
