// =============================================================================
// Playlist — Cloudflare Worker
//
// SETUP STEPS (in Cloudflare dashboard):
//   1. Create a new Worker (Workers & Pages → Create → "Hello World" → name it "playlist-backend")
//   2. Paste this entire file into the editor
//   3. Go to Settings → Variables and add:
//        KUSTOMER_API_KEY  (secret)  → your Kustomer API key
//   4. Go to Settings → KV Namespace Bindings → Add binding:
//        Variable name: KV
//        KV Namespace: create a new one called "playlist-data"
//   5. Deploy
// =============================================================================

const KUSTOMER_BASE = 'https://propercloth.api.kustomerapp.com/v1';

// ── CORS HEADERS ─────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

function errorResponse(message, status = 400, origin) {
  return jsonResponse({ error: message }, status, origin);
}

// ── KUSTOMER HELPER (with 429 retry + exponential backoff) ──────────────────
async function kustomer(method, endpoint, body, apiKey, retries = 3) {
  let delay = 1000; // start with 1 second
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${KUSTOMER_BASE}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 && attempt < retries) {
      // Rate limited — wait and retry
      const retryAfter = res.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : delay;
      await new Promise(r => setTimeout(r, waitMs));
      delay *= 2; // exponential backoff
      continue;
    }

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.errors?.[0]?.message || `Kustomer error ${res.status}`);
    }
    return data;
  }
}

// ── FETCH ALL SAVED SEARCHES (paginated, direct from Kustomer) ───────────────
async function fetchAllSearches(apiKey) {
  let allItems = [];
  let page = 1;
  while (true) {
    const data = await kustomer('GET', `/customers/searches?page=${page}&pageSize=200&filter=all`, null, apiKey);
    const items = data.data || [];
    allItems = allItems.concat(items);
    if (items.length < 200) break;
    page++;
    if (page > 10) break;
  }
  return allItems;
}

// ── GET SEARCH DEFINITION LOOKUP (KV cache → Kustomer fallback) ──────────────
// Returns a map of { searchId → queryDefinition }
// Hit Me always reads from cache. Cache is only refreshed by explicit manager action.
async function getSearchLookup(apiKey, kv, forceRefresh = false) {
  if (!forceRefresh) {
    try {
      const cached = await kv.get('search_definitions_cache');
      if (cached) return JSON.parse(cached);
    } catch {}
  }
  // Fetch fresh from Kustomer and cache indefinitely
  const allItems = await fetchAllSearches(apiKey);
  const lookup = {};
  for (const item of allItems) {
    if (item.id && item.attributes?.data) {
      lookup[item.id] = item.attributes.data;
    }
  }
  await kv.put('search_definitions_cache', JSON.stringify(lookup));
  return lookup;
}

// ── BUILD FLAT SEARCH LIST ───────────────────────────────────────────────────
// Returns a single "All Searches" group — flat alphabetical list.
// Avoids per-folder API calls which are slow and cause timeouts.
async function buildSearchGroups(apiKey, kv) {
  const allSearchItems = await fetchAllSearches(apiKey);

  // Deduplicate and sort alphabetically
  const seen = new Set();
  const searches = [];
  for (const s of allSearchItems) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      searches.push({ id: s.id, name: s.attributes?.name || s.id });
    }
  }
  searches.sort((a, b) => a.name.localeCompare(b.name));

  return [{ folderId: '__all__', folderName: 'All Searches', searches }];
}

// ── GOOGLE AUTH + ROLES ──────────────────────────────────────────────────────
// Roles: 'admin' (everything + manage access) and 'manager' (panel features).
// Admins listed in env.ADMIN_EMAILS (comma-separated) are fixed; others live in KV key "access".
const tokenCache = new Map(); // idToken -> { email, exp }

async function verifyGoogleToken(token, env) {
  const cached = tokenCache.get(token);
  if (cached && cached.exp * 1000 > Date.now()) return cached.email;

  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`);
  if (!res.ok) return null;
  const info = await res.json();
  if (info.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (info.email_verified !== 'true' && info.email_verified !== true) return null;
  const email = (info.email || '').toLowerCase();
  if (!email.endsWith('@' + (env.ALLOWED_DOMAIN || 'propercloth.com'))) return null;
  const exp = Number(info.exp);
  if (!exp || exp * 1000 < Date.now()) return null;
  if (tokenCache.size > 500) tokenCache.clear();
  tokenCache.set(token, { email, exp });
  return email;
}

function fixedAdmins(env) {
  return (env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

async function getAccessList(env) {
  const raw = await env.KV.get('access');
  return raw ? JSON.parse(raw) : [];
}

async function getRole(email, env) {
  if (fixedAdmins(env).includes(email)) return 'admin';
  const list = await getAccessList(env);
  return list.find(a => a.email === email)?.role || null;
}

// Returns { email, role } or null if not signed in with a valid propercloth.com Google account
async function authenticate(request, env) {
  if (!env.GOOGLE_CLIENT_ID) return null;
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const email = await verifyGoogleToken(token, env);
  if (!email) return null;
  return { email, role: await getRole(email, env) };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const origin = request.headers.get('Origin');

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── AUTH GATE ──────────────────────────────────────────────────────────
    // /api/assign (agent widget) stays open. Everything else needs a signed-in manager/admin.
    if (path.startsWith('/api/') && path !== '/api/assign') {
      if (!env.GOOGLE_CLIENT_ID) return errorResponse('Server auth is not configured', 500, origin);
      const auth = await authenticate(request, env);
      if (!auth) return errorResponse('Sign in required', 401, origin);

      if (path === '/api/me') {
        return jsonResponse({ email: auth.email, role: auth.role }, 200, origin);
      }
      if (!auth.role) return errorResponse('You do not have access to Playlist. Ask an admin.', 403, origin);

      if (path === '/api/access') {
        if (auth.role !== 'admin') return errorResponse('Admins only', 403, origin);
        if (method === 'GET') {
          return jsonResponse({ fixed: fixedAdmins(env), list: await getAccessList(env) }, 200, origin);
        }
        if (method === 'POST') {
          const body = await request.json();
          if (!Array.isArray(body)) return errorResponse('Expected an array', 400, origin);
          const domain = '@' + (env.ALLOWED_DOMAIN || 'propercloth.com');
          const clean = [];
          for (const a of body) {
            const email = String(a.email || '').trim().toLowerCase();
            if (!email.endsWith(domain)) return errorResponse(`${email || 'Email'} must be a ${domain} address`, 400, origin);
            if (!['admin', 'manager'].includes(a.role)) return errorResponse('Role must be admin or manager', 400, origin);
            if (!clean.some(c => c.email === email)) clean.push({ email, role: a.role });
          }
          await env.KV.put('access', JSON.stringify(clean));
          return jsonResponse({ ok: true }, 200, origin);
        }
      }
    }

    // ── GET /api/profiles ──────────────────────────────────────────────────
    if (path === '/api/profiles' && method === 'GET') {
      const raw = await env.KV.get('profiles');
      const profiles = raw ? JSON.parse(raw) : [];
      return jsonResponse(profiles, 200, origin);
    }

    // ── POST /api/profiles ─────────────────────────────────────────────────
    if (path === '/api/profiles' && method === 'POST') {
      const profiles = await request.json();
      if (!Array.isArray(profiles)) {
        return errorResponse('Expected an array of profiles', 400, origin);
      }
      await env.KV.put('profiles', JSON.stringify(profiles));
      // Refresh search definitions cache in background so Hit Me stays current
      env.KV.get('search_definitions_cache').then(cached => {
        if (!cached) {
          // Only refresh if cache is empty — don't block the response
          getSearchLookup(env.KUSTOMER_API_KEY, env.KV, true).catch(() => {});
        }
      }).catch(() => {});
      return jsonResponse({ ok: true }, 200, origin);
    }

    // ── GET /api/saved-searches ────────────────────────────────────────────
    // Returns folder-grouped structure: [{ folderId, folderName, searches: [{id, name}] }]
    // Results are cached in KV for 5 minutes to avoid repeated Kustomer API calls.
    if (path === '/api/saved-searches' && method === 'GET') {
      try {
        const forceRefresh = url.searchParams.get('refresh') === '1';

        // Check cache first
        if (!forceRefresh) {
          const cached = await env.KV.get('searches_cache');
          if (cached) return jsonResponse(JSON.parse(cached), 200, origin);
        }

        const folders = await buildSearchGroups(env.KUSTOMER_API_KEY, env.KV);

        // Cache the dropdown list indefinitely
        await env.KV.put('searches_cache', JSON.stringify(folders));

        // Also refresh the search definitions cache used by Hit Me and Bulk Distribute
        await getSearchLookup(env.KUSTOMER_API_KEY, env.KV, true);

        return jsonResponse(folders, 200, origin);
      } catch (err) {
        // On error, try returning stale cache rather than failing
        try {
          const stale = await env.KV.get('searches_cache');
          if (stale) return jsonResponse(JSON.parse(stale), 200, origin);
        } catch {}
        return errorResponse(err.message, 502, origin);
      }
    }

    // ── POST /api/assign ───────────────────────────────────────────────────
    if (path === '/api/assign' && method === 'POST') {
      let email, count;
      try {
        ({ email, count } = await request.json());
      } catch {
        return errorResponse('Invalid JSON body', 400, origin);
      }

      if (!email || !count) {
        return errorResponse('email and count are required', 400, origin);
      }
      if (![3, 5, 7].includes(Number(count))) {
        return errorResponse('count must be 3, 5, or 7', 400, origin);
      }
      count = Number(count);

      // 1. Find agent's Kustomer user ID by email
      let agentId;
      try {
        const userData = await kustomer(
          'GET',
          `/users?email=${encodeURIComponent(email)}`,
          null,
          env.KUSTOMER_API_KEY
        );
        const user = userData.data?.[0];
        if (!user) {
          return errorResponse(`No Kustomer user found for ${email}`, 404, origin);
        }
        agentId = user.id;
      } catch (err) {
        return errorResponse(`Could not look up agent: ${err.message}`, 502, origin);
      }

      // 2. Find profile for this agent
      const raw = await env.KV.get('profiles');
      const profiles = raw ? JSON.parse(raw) : [];
      const profile = profiles.find(p =>
        p.users.map(u => u.toLowerCase()).includes(email.toLowerCase())
      );
      if (!profile) {
        return errorResponse(`${email} is not assigned to any playlist profile`, 404, origin);
      }
      if (!profile.searches || profile.searches.length === 0) {
        return errorResponse(`Profile "${profile.name}" has no saved searches configured`, 400, origin);
      }

      // 3. Get search query definitions from KV cache (no Kustomer call unless cache is empty)
      let searchLookup = {};
      try {
        searchLookup = await getSearchLookup(env.KUSTOMER_API_KEY, env.KV, false);
      } catch (err) {
        return errorResponse(`Could not fetch search definitions: ${err.message}`, 502, origin);
      }

      // 4. Work through searches in priority order, filling gaps from later searches
      //
      // Logic:
      //   - Each search has a configured quantity (its "target")
      //   - We scale all targets proportionally to hit the agent's chosen count
      //   - We go through searches in order; if one comes up short, carry the
      //     shortfall forward and try to fill it from the next search
      //   - Continue until the agent's count is met or all searches are exhausted

      const totalWeight = profile.searches.reduce((sum, s) => sum + (s.quantity || 1), 0);

      // Build initial scaled targets (same proportional logic as before)
      let scaledSearches = profile.searches.map(s => ({
        ...s,
        target: Math.floor(((s.quantity || 1) / totalWeight) * count),
        query: searchLookup[s.searchId] || null,
      }));
      // Distribute rounding remainder to highest-weight searches
      let roundingRemainder = count - scaledSearches.reduce((sum, s) => sum + s.target, 0);
      const byWeight = [...scaledSearches].sort((a, b) => (b.quantity || 1) - (a.quantity || 1));
      for (let i = 0; roundingRemainder > 0 && i < byWeight.length; i++) {
        const match = scaledSearches.find(s => s.searchId === byWeight[i].searchId);
        if (match) { match.target += 1; roundingRemainder--; }
      }

      // Now execute searches sequentially, carrying shortfall forward
      let slotsRemaining = count;
      const results = [];

      for (const s of scaledSearches) {
        if (slotsRemaining <= 0) {
          results.push({ search: s.searchName, requested: 0, assigned: 0 });
          continue;
        }

        if (!s.query) {
          results.push({ search: s.searchName, requested: s.target, assigned: 0, error: 'Could not fetch search definition' });
          continue;
        }

        // Request up to slotsRemaining (covers this search's target + any carryover)
        const requestQty = slotsRemaining;

        try {
          const searchBody = {
            ...s.query,
            queryContext: 'conversation',
            sort: [{ conversation_updated_at: 'asc' }],
          };
          const searchData = await kustomer(
            'POST',
            `/customers/search?page=1&pageSize=${requestQty}`,
            searchBody,
            env.KUSTOMER_API_KEY
          );
          const conversations = searchData.data || [];

          // Only assign up to slotsRemaining
          const toAssign = conversations.slice(0, slotsRemaining);
          const assignedIds = [];
          for (const convo of toAssign) {
            try {
              await kustomer(
                'PATCH',
                `/conversations/${convo.id}`,
                { assignedUsers: [agentId] },
                env.KUSTOMER_API_KEY
              );
              assignedIds.push(convo.id);
            } catch (assignErr) {
              console.error(`Failed to assign ${convo.id}:`, assignErr.message);
            }
          }

          slotsRemaining -= assignedIds.length;
          results.push({ search: s.searchName, requested: requestQty, assigned: assignedIds.length });
        } catch (err) {
          results.push({ search: s.searchName, requested: requestQty, assigned: 0, error: err.message });
        }
      }

      const totalAssigned = results.reduce((sum, r) => sum + r.assigned, 0);
      return jsonResponse({ ok: true, totalAssigned, results }, 200, origin);
    }

    // ── POST /api/bulk-count ──────────────────────────────────────────────
    // Returns the total conversation count for a saved search (for Calculate preview)
    if (path === '/api/bulk-count' && method === 'POST') {
      let searchId;
      try {
        ({ searchId } = await request.json());
      } catch {
        return errorResponse('Invalid JSON body', 400, origin);
      }
      if (!searchId) return errorResponse('searchId is required', 400, origin);

      try {
        const lookup = await getSearchLookup(env.KUSTOMER_API_KEY, env.KV, false);
        const query = lookup[searchId];
        if (!query) return errorResponse('Could not find saved search definition — try Refresh Searches in the control panel', 404, origin);

        // Fetch just page 1 with pageSize=1 to get total from meta
        const searchBody = { ...query, queryContext: 'conversation' };
        const data = await kustomer('POST', `/customers/search?page=1&pageSize=1`, searchBody, env.KUSTOMER_API_KEY);
        const total = data.meta?.total ?? data.data?.length ?? 0;
        return jsonResponse({ total }, 200, origin);
      } catch (err) {
        return errorResponse(err.message, 502, origin);
      }
    }

    // ── POST /api/bulk-distribute ─────────────────────────────────────────
    // Body: { searchId, searchName, agents: [email, ...] }
    // Fetches all conversations from the saved search, distributes evenly across agents.
    // Remainder distributed round-robin. Oldest-first order not required.
    if (path === '/api/bulk-distribute' && method === 'POST') {
      let searchId, searchName, agents;
      try {
        ({ searchId, searchName, agents } = await request.json());
      } catch {
        return errorResponse('Invalid JSON body', 400, origin);
      }

      if (!searchId || !agents || agents.length === 0) {
        return errorResponse('searchId and agents are required', 400, origin);
      }

      // 1. Resolve all agent emails to Kustomer user IDs in parallel
      const agentIdMap = {}; // email → userId
      await Promise.all(agents.map(async email => {
        try {
          const userData = await kustomer('GET', `/users?email=${encodeURIComponent(email)}`, null, env.KUSTOMER_API_KEY);
          const user = userData.data?.[0];
          if (user) agentIdMap[email] = user.id;
        } catch (err) {
          console.error(`Could not resolve ${email}:`, err.message);
        }
      }));

      const resolvedAgents = agents.filter(e => agentIdMap[e]);
      if (resolvedAgents.length === 0) {
        return errorResponse('None of the provided agents could be found in Kustomer', 404, origin);
      }

      // 2. Get saved search query definition from KV cache
      let query = null;
      try {
        const lookup = await getSearchLookup(env.KUSTOMER_API_KEY, env.KV, false);
        query = lookup[searchId] || null;
      } catch (err) {
        return errorResponse(`Could not fetch search definition: ${err.message}`, 502, origin);
      }

      if (!query) {
        return errorResponse(`Could not find saved search definition for ID: ${searchId}`, 404, origin);
      }

      // 3. Fetch ALL conversations from the saved search (paginate through all pages)
      let allConversations = [];
      try {
        const searchBody = { ...query, queryContext: 'conversation' };
        let page = 1;
        const pageSize = 100;
        while (true) {
          const searchData = await kustomer(
            'POST',
            `/customers/search?page=${page}&pageSize=${pageSize}`,
            searchBody,
            env.KUSTOMER_API_KEY
          );
          const convos = searchData.data || [];
          allConversations = allConversations.concat(convos);
          if (convos.length < pageSize) break;
          page++;
          if (page > 50) break; // safety cap at 5000 conversations
        }
      } catch (err) {
        return errorResponse(`Could not fetch conversations: ${err.message}`, 502, origin);
      }

      if (allConversations.length === 0) {
        return errorResponse('No conversations found in the selected saved search', 404, origin);
      }

      // 4. Distribute conversations evenly across agents
      // Base amount each agent gets, remainder distributed round-robin
      const total = allConversations.length;
      const n = resolvedAgents.length;
      const base = Math.floor(total / n);
      const remainder = total % n;

      // Build assignment buckets: agentIndex → [conversationIds]
      const buckets = resolvedAgents.map((_, i) => ({
        email: resolvedAgents[i],
        agentId: agentIdMap[resolvedAgents[i]],
        conversations: [],
      }));

      let convoIndex = 0;
      for (let i = 0; i < n; i++) {
        const qty = base + (i < remainder ? 1 : 0);
        for (let j = 0; j < qty && convoIndex < total; j++) {
          buckets[i].conversations.push(allConversations[convoIndex++].id);
        }
      }

      // 5. Assign conversations to agents in parallel
      const assignments = await Promise.all(buckets.map(async bucket => {
        let assigned = 0;
        for (const convoId of bucket.conversations) {
          try {
            await kustomer('PATCH', `/conversations/${convoId}`, { assignedUsers: [bucket.agentId] }, env.KUSTOMER_API_KEY);
            assigned++;
          } catch (err) {
            console.error(`Failed to assign ${convoId} to ${bucket.email}:`, err.message);
          }
        }
        return { email: bucket.email, assigned };
      }));

      const totalAssigned = assignments.reduce((sum, a) => sum + a.assigned, 0);
      return jsonResponse({ ok: true, totalAssigned, assignments }, 200, origin);
    }

    // ── 404 ────────────────────────────────────────────────────────────────
    return errorResponse('Not found', 404, origin);
  },
};
