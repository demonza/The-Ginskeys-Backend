// ══════════════════════════════════════════════════
// DB SEED — run with: node db/seed.js
// Populates real Ginskeys transaction history + admin user
// ══════════════════════════════════════════════════
require('dotenv').config();
const bcrypt = require('bcrypt');
const { v4: uuid } = require('uuid');
const pool = require('./pool');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');

// ─── Real Ginskeys transaction history ─────────────
const RAW_TXNS = [
  { date:'2022-06-10', desc:'Concerto 6 (10/06/2022)',      type:'income',  cat:'Espetáculo',  tags:['tour'],       amount: 200    },
  { date:'2022-06-15', desc:'Dívida Tiago',                 type:'expense', cat:'Equipamento', tags:[],             amount: 25     },
  { date:'2022-06-25', desc:'Concerto Ponto (25/06/2022)',   type:'income',  cat:'Espetáculo',  tags:['tour'],       amount: 300    },
  { date:'2022-07-01', desc:'Doações',                      type:'income',  cat:'Doações',     tags:['donation'],   amount: 270.70 },
  { date:'2022-08-05', desc:'Dívida Fábio',                 type:'expense', cat:'Equipamento', tags:[],             amount: 5.70   },
  { date:'2022-08-10', desc:'Ilustração Igor',              type:'expense', cat:'Artwork',     tags:[],             amount: 60     },
  { date:'2022-09-28', desc:'Dívida Musifex',               type:'expense', cat:'Equipamento', tags:[],             amount: 70     },
  { date:'2022-10-21', desc:'Concerto 6 (21/10/2022)',      type:'income',  cat:'Espetáculo',  tags:['tour'],       amount: 250    },
  { date:'2023-02-01', desc:'Ilustração Igor',              type:'expense', cat:'Artwork',     tags:[],             amount: 80     },
  { date:'2023-02-10', desc:'Pagar Gravação EP',            type:'expense', cat:'Estúdio',     tags:['recording'],  amount: 450    },
  { date:'2023-02-15', desc:'Distribuidora',                type:'expense', cat:'Distribuição',tags:['distribution'],amount: 5    },
  { date:'2023-03-01', desc:'Gasóleo',                      type:'expense', cat:'Transporte',  tags:['transport'],  amount: 5      },
  { date:'2023-03-15', desc:'Jantar Cunha',                 type:'expense', cat:'Outros',      tags:[],             amount: 16.90  },
  { date:'2023-03-31', desc:'Concerto 6 (31/03/2023)',      type:'income',  cat:'Espetáculo',  tags:['tour'],       amount: 250    },
  { date:'2023-04-01', desc:'Gasóleo + Portagens',          type:'expense', cat:'Transporte',  tags:['transport'],  amount: 43.40  },
  { date:'2023-07-01', desc:'Jolas Rui Fador',              type:'expense', cat:'Outros',      tags:[],             amount: 14     },
  { date:'2023-08-01', desc:'Concerto Ta Squinhas',         type:'income',  cat:'Espetáculo',  tags:['tour'],       amount: 1200   },
  { date:'2023-10-01', desc:'PA',                           type:'expense', cat:'Equipamento', tags:[],             amount: 150    },
  { date:'2024-03-01', desc:'Encomenda Thomann',            type:'expense', cat:'Equipamento', tags:[],             amount: 350    },
  { date:'2024-03-05', desc:'Donativo',                     type:'income',  cat:'Doações',     tags:['donation'],   amount: 60     },
  { date:'2024-04-01', desc:'Concerto Juventude',           type:'income',  cat:'Espetáculo',  tags:['tour'],       amount: 1200   },
  { date:'2024-04-15', desc:'IRS',                          type:'expense', cat:'Impostos',    tags:['tax'],        amount: 235    },
  { date:'2024-04-20', desc:'Gasóleo',                      type:'expense', cat:'Transporte',  tags:['transport'],  amount: 20     },
  { date:'2024-06-01', desc:'Concerto Odemira',             type:'income',  cat:'Espetáculo',  tags:['tour'],       amount: 1000   },
  { date:'2024-08-01', desc:'Portagens',                    type:'expense', cat:'Transporte',  tags:['transport'],  amount: 8.65   },
  { date:'2024-08-05', desc:'IVA',                          type:'expense', cat:'Impostos',    tags:['tax'],        amount: 89.90  },
  { date:'2024-08-10', desc:'Gasóleo',                      type:'expense', cat:'Transporte',  tags:['transport'],  amount: 60     },
  { date:'2024-08-12', desc:'Pedal + Tampões + Cordas BX',  type:'expense', cat:'Equipamento', tags:[],             amount: 308.80 },
  { date:'2024-08-15', desc:'Portagens',                    type:'expense', cat:'Transporte',  tags:['transport'],  amount: 33.10  },
  { date:'2024-08-18', desc:'Dívida Mendonça',              type:'income',  cat:'Equipamento', tags:[],             amount: 108.80 },
  { date:'2024-09-01', desc:'Gasóleo',                      type:'expense', cat:'Transporte',  tags:['transport'],  amount: 30     },
  { date:'2024-09-05', desc:'Portagens',                    type:'expense', cat:'Transporte',  tags:['transport'],  amount: 24.20  },
  { date:'2024-09-10', desc:'Portagens + Ponte',            type:'expense', cat:'Transporte',  tags:['transport'],  amount: 19.40  },
  { date:'2024-10-01', desc:'Gravação',                     type:'expense', cat:'Estúdio',     tags:['recording'],  amount: 400    },
  { date:'2024-10-05', desc:'Portagens + Ponte',            type:'expense', cat:'Transporte',  tags:['transport'],  amount: 21     },
  { date:'2024-10-10', desc:'Gasóleo',                      type:'expense', cat:'Transporte',  tags:['transport'],  amount: 25     },
  { date:'2025-02-01', desc:'Dívida Mendonça',              type:'expense', cat:'Equipamento', tags:[],             amount: 218    },
  { date:'2025-02-15', desc:'Gravação',                     type:'expense', cat:'Estúdio',     tags:['recording'],  amount: 400    },
  { date:'2026-03-01', desc:'1/2 Dívida Mendonça',          type:'income',  cat:'Crédito',     tags:[],             amount: 109    },
  { date:'2026-03-10', desc:'2/2 Dívida Mendonça',          type:'income',  cat:'Crédito',     tags:[],             amount: 109    },
  { date:'2026-03-15', desc:'Cordas Baixo',                 type:'expense', cat:'Equipamento', tags:[],             amount: 24.40  },
  { date:'2026-03-18', desc:'Portagens + Ponte',            type:'expense', cat:'Transporte',  tags:['transport'],  amount: 11     },
  { date:'2026-03-18', desc:'Distrokid',                    type:'expense', cat:'Distribuição',tags:['distribution'],amount: 27.40 },
];

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Admin user ──────────────────────────────────
    const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'GK!Admin2026', SALT_ROUNDS);
    const adminId   = uuid();
    await client.query(`
      INSERT INTO users (id, email, name, role, password_hash, active)
      VALUES ($1, 'mendonza@theginskeys.com', 'Mendonza', 'admin', $2, true)
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
      RETURNING id
    `, [adminId, adminHash]);

    // Fetch real admin id (might already exist)
    const { rows: adminRows } = await client.query(
      "SELECT id FROM users WHERE email='mendonza@theginskeys.com'"
    );
    const realAdminId = adminRows[0].id;

    // ── Other users ─────────────────────────────────
    const otherUsers = [
      { email:'fabio@ginskeys.com',     name:'Fábio Batista',     role:'admin'     },
      { email:'pedro@ginskeys.com', name:'Pedro Nunes.', role:'admin'  },
      { email:'manel@ginskeys.com',   name:'Manuel Dias',   role:'admin'      },
    ];
    for (const u of otherUsers) {
      const h = await bcrypt.hash('GK!Change2026', SALT_ROUNDS);
      await client.query(`
        INSERT INTO users (id, email, name, role, password_hash, active)
        VALUES ($1,$2,$3,$4,$5,true)
        ON CONFLICT (email) DO NOTHING
      `, [uuid(), u.email, u.name, u.role, h]);
    }

    // ── Tours ───────────────────────────────────────
    const TOURS = [
      { id: uuid(), name:'Concertos 2022', start:'2022-06-10', end:'2022-10-21', budget:200,  status:'completed' },
      { id: uuid(), name:'Tasquinhas 2023',start:'2023-08-01', end:'2023-08-01', budget:100,  status:'completed' },
      { id: uuid(), name:'Semana da Juventude 2024', start:'2024-04-01', end:'2024-04-01', budget:100, status:'completed' },
      { id: uuid(), name:'Abril em Odemira 2024',    start:'2024-06-01', end:'2024-06-01', budget:100, status:'completed' },
    ];
    const tourMap = {};
    for (const t of TOURS) {
      await client.query(`
        INSERT INTO tours (id, name, start_date, end_date, budget, status)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT DO NOTHING
      `, [t.id, t.name, t.start, t.end, t.budget, t.status]);
      tourMap[t.name] = t.id;
    }

    // ── Categories lookup ───────────────────────────
    const { rows: catRows } = await client.query('SELECT id, name FROM categories');
    const catMap = {};
    catRows.forEach(c => { catMap[c.name.toLowerCase()] = c.id; });

    // ── Transactions ────────────────────────────────
    // Check if already seeded
    const { rows: existing } = await client.query('SELECT COUNT(*) FROM transactions');
    if (parseInt(existing[0].count) > 0) {
      console.log('ℹ️  Transactions already exist — skipping transaction seed.');
    } else {
      // Compute running balance starting from 0 (real starting balance)
      const sorted = [...RAW_TXNS].sort((a,b)=>a.date.localeCompare(b.date));
      const TARGET_END_BALANCE = 1626.65;
      const totalMovement = sorted.reduce((s,t)=>s+(t.type==='income'?t.amount:-t.amount),0);
      let running = parseFloat((TARGET_END_BALANCE - totalMovement).toFixed(2));

      for (const [i, t] of sorted.entries()) {
        const signed = t.type === 'income' ? t.amount : -t.amount;
        running = parseFloat((running + signed).toFixed(2));
        const catKey = t.cat.toLowerCase();
        const catId  = catMap[catKey] || null;

        // Map transactions to tours by tag
        let tourId = null;
        if (t.tags && t.tags.includes('tour')) {
          // Match by year range
          const txYear = t.date.slice(0, 4);
          if (txYear === '2022') tourId = tourMap['Concertos 2022'] || null;
          else if (t.date === '2023-08-01') tourId = tourMap['Tasquinhas 2023'] || null;
          else if (t.date === '2024-04-01') tourId = tourMap['Semana da Juventude 2024'] || null;
          else if (t.date === '2024-06-01') tourId = tourMap['Abril em Odemira 2024'] || null;
        }

        await client.query(`
          INSERT INTO transactions
            (id, date, type, category_id, amount, currency, amount_eur, description, tags, tour_id, reconciled, created_by)
          VALUES ($1,$2,$3,$4,$5,'EUR',$5,$6,$7,$8,true,$9)
        `, [
          uuid(), t.date, t.type, catId,
          t.amount, t.desc,
          t.tags, tourId, realAdminId
        ]);
      }
      console.log(`✅ Seeded ${sorted.length} transactions.`);
    }

    // ── Streaming snapshots ─────────────────────────
    await client.query(`
      INSERT INTO streaming_snapshots (platform, period, streams, revenue_eur)
      VALUES
        ('spotify', '2026-03-01', 2200, 0.14),
        ('youtube', '2026-03-01', 2200, 0.00)
      ON CONFLICT (platform, period) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('✅ Seed complete.');
    console.log('');
    console.log('Login credentials:');
    console.log('  Admin:       mendonza@theginskeys.com   / GK!Admin2026');
    console.log('  Admin:     fabio@ginskeys.com     / GK!Change2026');
    console.log('  Admin:  pedro@ginskeys.com / GK!Change2026');
    console.log('  Admin:      manel@ginskeys.com   / GK!Change2026');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
