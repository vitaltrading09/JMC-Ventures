// Docker HEALTHCHECK for every role of this image. The api role answers on
// PORT; ingest-only and jobs-only containers answer on HEALTH_PORT (roles.ts).
import { parseRoles } from './roles';

const roles = parseRoles(process.env.ROLES);
const port = roles.has('api')
    ? Number(process.env.PORT || 3002)
    : Number(process.env.HEALTH_PORT || 9090);

fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4_000) })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch(() => process.exit(1));
