/**
 * Per-environment guidance for the agent.
 *  - The TEXT is returned by activate_env and repeated in every command banner.
 *  - ENFORCEMENT (optional) is a heuristic command check in the Bash hook. It only runs on commands that
 *    reference a variable of that environment. It catches common mutating or destructive tools
 *    (SQL clients, kubectl, terraform, curl, aws, git push, ...) but is a seatbelt, not a guarantee:
 *    the agent can still run SQL from a file or obfuscate a command. Use a read-only database user for real safety.
 */

export const GUIDANCE_LEVELS = ['read_only', 'write', 'full'];

export const LEVEL_LABEL = { read_only: 'READ-ONLY', write: 'WRITE', full: 'FULL' };

export function guidanceText(env, level, enforce) {
  const enforced = enforce ? ' The owner has ENFORCED this: commands that look mutating or destructive will be blocked.' : ' This is guidance from the owner; follow it strictly.';
  switch (level) {
    case 'read_only':
      return `GUIDANCE FOR "${env}": READ-ONLY. Use these variables ONLY to read data (SELECT queries, GET requests, list/describe/inspect commands). Do NOT perform ANY write or change on this environment: no INSERT, UPDATE, DELETE or schema changes, no migrations or seeds, no deploys or restarts, no POST/PUT/PATCH/DELETE requests, no configuration changes, no file uploads. If a task needs a change, STOP and ask the user.${enforced}`;
    case 'write':
      return `GUIDANCE FOR "${env}": WRITE. You MAY write to this environment (INSERT/UPDATE, create resources, apply small changes) but be cautious. NO destructive operations: no DROP, TRUNCATE or DELETE of data, no destroying or deleting resources, no recursive deletes, no force-push. Prefer small, reversible changes and tell the user what you are about to change. If something destructive seems necessary, STOP and ask the user.${enforced}`;
    case 'full':
      return `GUIDANCE FOR "${env}": FULL. You may perform operations on this environment, but be cautious. BEFORE any destructive or irreversible operation (DROP, TRUNCATE, bulk DELETE, destroying or deleting resources, force-push, recursive deletes) STOP and ask the user for explicit confirmation first.${enforced}`;
    default:
      return `GUIDANCE FOR "${env}": none set. Be cautious and ask before destructive operations.`;
  }
}

const SQL_CLIENT = /\b(psql|pgcli|mysql|mariadb|sqlite3|sqlcmd|mongosh|cqlsh|clickhouse-client|duckdb|usql)\b/i;
const SQL_WRITE =
  /\b(insert\s+into|update\s+[\w."`\[\]]+\s+set|delete\s+from|drop\s+\w+|truncate|alter\s+\w+|create\s+\w+|grant|revoke|merge\s+into|replace\s+into|copy\s+[\w."]+\s+from|vacuum\s+full|reindex|cluster|lock\s+table|call\s+\w+|\.(insert|update|delete|drop|remove|replace)\w*\()/i;
const SQL_FROM_FILE = /(\s-f\b|\s--file\b|\s<\s*\S|\\i\s)/;
const SQL_DESTRUCTIVE = /\b(drop\s+\w+|truncate|delete\s+from|alter\s+table\s+[\w."]+\s+drop|\.(drop|deleteMany|deleteOne|remove)\w*\()/i;

const REDIS_CLIENT = /\bredis-cli\b/i;
const REDIS_WRITE = /\b(set|setex|setnx|mset|del|unlink|hset|hdel|lpush|rpush|lpop|rpop|sadd|srem|zadd|zrem|expire|incr|decr|incrby|append|publish|eval|evalsha|config\s+set|flushall|flushdb|rename|move|restore|migrate|script\s+flush|shutdown)\b/i;
const REDIS_DESTRUCTIVE = /\b(flushall|flushdb|del|unlink|shutdown)\b/i;

const READ_ONLY_BLOCK = [
  [/\bkubectl\s+(?:\S+\s+)*?(apply|delete|patch|scale|rollout|replace|create|edit|drain|cordon|uncordon|exec|cp|label|annotate|set|taint|run|expose)\b/, 'kubectl command that changes the cluster'],
  [/\bhelm\s+(install|upgrade|uninstall|delete|rollback)\b/, 'helm release change'],
  [/\bterraform\s+(apply|destroy|import|taint|untaint|state\s+(rm|mv|push))\b/, 'terraform change'],
  [/\bdocker\s+(rm|rmi|stop|kill|prune|push|restart|volume\s+rm|system\s+prune)\b/, 'docker change'],
  [/\bgit\s+push\b/, 'git push'],
  [/\baws\s+s3\s+(rm|mv|rb|mb|sync)\b/, 'S3 change'],
  [/\baws\s+\S+\s+(?:delete|put|create|update|terminate|modify|remove|run|stop|start|reboot|invoke|publish|send|attach|detach|register|deregister)[\w-]*/, 'AWS change'],
  [/\bgcloud\s+.*\b(delete|create|update|deploy|resize|set-iam-policy)\b/, 'gcloud change'],
  [/\baz\s+.*\b(delete|create|update|deploy|start|stop|restart)\b/, 'az change'],
  [/\bcurl\b[^\n|;&]*?(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|\s--request\s+(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-\w+)?|-F|--form|-T|--upload-file|--json)\b)/i, 'HTTP request that writes'],
  [/\bwget\b[^\n|;&]*\s--(?:post-data|post-file|method=(?:POST|PUT|PATCH|DELETE))/i, 'HTTP request that writes'],
  [/\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:migrate|seed|deploy|db:\w+|release|publish)\b/, 'migration, seed or deploy script'],
  [/\b(?:prisma|sequelize|knex|alembic|flyway|liquibase|typeorm|drizzle-kit)\b[^\n|;&]*\b(migrate|upgrade|push|seed|rollback|reset|update|deploy)\b/, 'migration tool'],
  [/\b(?:rake|rails)\s+db:(migrate|seed|reset|drop|rollback|setup)/, 'migration task'],
  [/\b(?:pg_restore|mysqldump\s+.*--no-create|mongorestore|redis-cli\s+.*--pipe)\b/, 'restore or bulk load'],
];

const WRITE_BLOCK = [
  [/\bkubectl\s+(?:\S+\s+)*?(delete|drain|replace\s+--force)\b/, 'kubectl delete or drain'],
  [/\bterraform\s+(destroy|state\s+rm)\b|\bterraform\s+apply\b[^\n|;&]*-destroy/, 'terraform destroy'],
  [/\bdocker\s+(rm|rmi|kill|prune|volume\s+rm|system\s+prune)\b/, 'docker removal'],
  [/\bgit\s+push\b[^\n|;&]*(?:\s-f\b|--force)|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-\w*f/, 'force push or hard reset'],
  [/\baws\s+s3\s+(rm|rb)\b|\baws\s+\S+\s+(?:delete|terminate|remove|deregister)[\w-]*/, 'AWS delete'],
  [/\bgcloud\s+.*\bdelete\b|\baz\s+.*\bdelete\b/, 'cloud resource delete'],
  [/\bcurl\b[^\n|;&]*?(?:\s-X\s*DELETE\b|\s--request\s+DELETE\b)/i, 'HTTP DELETE'],
  [/\brm\s+-[a-zA-Z]*[rR]|\bfind\b[^\n|;&]*-delete\b|\bshred\b|\bmkfs\b/, 'recursive or irreversible file deletion'],
  [/\b(?:prisma\s+migrate\s+reset|prisma\s+db\s+push\s+--force-reset|rake\s+db:(drop|reset)|rails\s+db:(drop|reset))/, 'database reset'],
];

/** Returns a reason string if the command breaks the level's rules, else null. */
export function violates(command, level) {
  if (level === 'full' || !GUIDANCE_LEVELS.includes(level)) return null;
  const sql = SQL_CLIENT.test(command);
  const redis = REDIS_CLIENT.test(command);
  if (level === 'read_only') {
    if (sql && SQL_WRITE.test(command)) return 'it contains SQL that writes or changes the schema';
    if (sql && SQL_FROM_FILE.test(command)) return 'SQL read from a file or stdin cannot be checked in read-only mode (pass the query with -c)';
    if (redis && REDIS_WRITE.test(command)) return 'it contains a Redis command that writes';
    for (const [re, why] of READ_ONLY_BLOCK) if (re.test(command)) return why;
    return null;
  }
  if (sql && SQL_DESTRUCTIVE.test(command)) return 'it contains a destructive SQL statement';
  if (redis && REDIS_DESTRUCTIVE.test(command)) return 'it contains a destructive Redis command';
  for (const [re, why] of WRITE_BLOCK) if (re.test(command)) return why;
  return null;
}
