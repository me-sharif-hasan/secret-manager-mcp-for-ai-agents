import test from 'node:test';
import assert from 'node:assert/strict';
import { violates, guidanceText, GUIDANCE_LEVELS } from '../src/core/guidance.js';

const table = (level, deny, allow) => {
  for (const c of deny) assert.ok(violates(c, level), `${level} should block: ${c}`);
  for (const c of allow) assert.equal(violates(c, level), null, `${level} should allow: ${c}`);
};

test('read_only blocks anything that writes, allows reads', () => {
  table(
    'read_only',
    [
      'psql -c "INSERT INTO t VALUES (1)"', 'psql -c "update users set a=1"', 'psql -c "DROP TABLE t"', 'psql -c "create table x(a int)"',
      'psql -f migration.sql', 'psql < dump.sql', 'mysql -e "delete from t"', 'redis-cli SET a b', 'redis-cli FLUSHALL',
      'kubectl apply -f x.yaml', 'kubectl delete pod x', 'kubectl -n prod scale deploy/a --replicas=0', 'terraform apply', 'helm upgrade a b',
      'curl -X POST https://x.test', 'curl -d \'{}\' https://x.test', 'curl --request DELETE https://x.test', 'git push origin main',
      'aws s3 rm s3://b/x', 'aws ec2 terminate-instances --instance-ids i-1', 'npm run migrate', 'rails db:migrate', 'prisma migrate deploy', 'docker rm c1',
    ],
    [
      'psql -c "select count(*) from orders"', 'psql -c "\\dt"', 'psql -c "select * from updates where deleted_at is null"', 'redis-cli GET a', 'redis-cli --scan',
      'kubectl get pods', 'kubectl logs x', 'terraform plan', 'helm list', 'curl https://x.test/health', 'curl -H "A: b" https://x.test', 'git log --oneline',
      'aws s3 ls', 'aws ec2 describe-instances', 'docker ps', 'npm test', 'ls -la',
    ],
  );
});

test('write blocks destructive only', () => {
  table(
    'write',
    [
      'psql -c "DROP TABLE t"', 'psql -c "delete from users"', 'psql -c "truncate t"', 'psql -c "alter table t drop column a"', 'redis-cli FLUSHALL', 'redis-cli DEL a',
      'kubectl delete pod x', 'terraform destroy', 'rm -rf /tmp/x', 'git push --force origin main', 'git reset --hard HEAD~3', 'curl -X DELETE https://x.test',
      'aws s3 rb s3://b', 'docker system prune -af', 'rake db:drop',
    ],
    [
      'psql -c "insert into t values (1)"', 'psql -c "update t set a=1 where id=2"', 'psql -c "select 1"', 'redis-cli SET a b', 'kubectl apply -f x.yaml',
      'terraform apply', 'git push origin main', 'curl -X POST https://x.test', 'rm file.txt', 'npm run migrate',
    ],
  );
});

test('full never blocks (ask-first is guidance only)', () => {
  table('full', [], ['psql -c "DROP TABLE t"', 'rm -rf /', 'terraform destroy']);
  assert.equal(violates('anything', 'nonsense'), null);
});

test('guidance text is explicit about what is allowed', () => {
  assert.deepEqual(GUIDANCE_LEVELS, ['read_only', 'write', 'full']);
  const ro = guidanceText('prod', 'read_only', true);
  assert.match(ro, /READ-ONLY/);
  assert.match(ro, /Do NOT perform ANY write/);
  assert.match(ro, /ENFORCED/);
  assert.match(guidanceText('uat', 'write', false), /NO destructive operations/);
  assert.match(guidanceText('uat', 'write', false), /guidance from the owner/);
  assert.match(guidanceText('dev', 'full', true), /ask the user for explicit confirmation/);
});
