// Run only against the disposable calendar verification environment.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const base = process.env.CALENDAR_TEST_API;
if (
  base !== 'http://localhost:3311/api/v1' ||
  !process.env.DATABASE_URL?.includes('/rete_calendar_d743?')
)
  throw Error('Use the dedicated calendar verification API and DB');
function client() {
  let cookie = '';
  return async (path, method = 'GET', body) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3310',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
}
test('shared calendar CRUD, group grants, tags, boundaries and storage constraints', async () => {
  const admin = client(),
    member = client(),
    anonymous = client();
  assert.equal(
    (await anonymous('/calendar-events?from=2026-10-01T00:00:00Z&to=2026-12-01T00:00:00Z')).status,
    401,
  );
  assert.equal(
    (await admin('/auth/login', 'POST', { email: 'admin@rete.local', password: 'ReteAdmin1234!' }))
      .status,
    200,
  );
  assert.equal(
    (
      await member('/auth/login', 'POST', {
        email: 'of-admin@struct-pass.example',
        password: 'ReteDemo1234!',
      })
    ).status,
    200,
  );
  const memberId = (await member('/auth/me')).body.data.id;
  for (const old of (await admin('/user-groups')).body.data.filter((g) =>
    g.name.startsWith('Calendar integration '),
  ))
    await admin(`/user-groups/${old.id}`, 'DELETE');
  const input = {
    title: '工程%_確認',
    startAt: '2026-10-23T09:00:00+09:00',
    endAt: '2026-10-24T00:00:00+09:00',
    memo: '検索メモ',
  };
  assert.equal((await member('/calendar-events', 'POST', input)).status, 403);
  const group = (
    await admin('/user-groups', 'POST', {
      name: 'Calendar integration A',
      canEditHomeCalendar: true,
      canEditHomeBoard: true,
    })
  ).body.data;
  assert.ok(group.id);
  assert.equal(group.canEditHomeCalendar, true);
  assert.equal(group.canManageHomeTags, false);
  assert.equal(
    (await admin(`/user-groups/${group.id}`, 'PATCH', { canEditHomeCalendar: null })).status,
    400,
  );
  assert.equal(
    (await admin(`/user-groups/${group.id}/members`, 'POST', { accountId: memberId })).status,
    201,
  );
  assert.equal((await member('/home/permissions')).body.data.calendarEdit, true);
  const tagResponse = await admin('/announcement-tags', 'POST', {
    kind: 'calendar',
    name: '工程確認',
    icon: 'Tag',
    color: 'slate',
  });
  assert.equal(tagResponse.status, 201);
  const tag = tagResponse.body.data;
  assert.equal(
    (
      await member('/announcement-tags', 'POST', {
        kind: 'calendar',
        name: '不許可',
        icon: 'Tag',
        color: 'slate',
      })
    ).status,
    403,
  );
  assert.equal((await member('/announcement-tags?kind=calendar&includeArchived=true')).status, 403);
  const created = await member('/calendar-events', 'POST', { ...input, tagIds: [tag.id] });
  assert.equal(created.status, 201);
  let event = created.body.data;
  assert.equal(event.revision, 1);
  assert.equal(event.tags[0].id, tag.id);
  const range = (from, to, q = '') =>
    `/calendar-events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&q=${encodeURIComponent(q)}`;
  assert.ok(
    (await member(range('2026-10-22T15:00:00Z', '2026-10-23T15:00:00Z', '%_'))).body.data.some(
      (e) => e.id === event.id,
    ),
  );
  assert.ok(
    !(await member(range('2026-10-23T15:00:00Z', '2026-10-24T15:00:00Z'))).body.data.some(
      (e) => e.id === event.id,
    ),
  );
  assert.equal(
    (
      await member(`/calendar-events/${event.id}`, 'PATCH', {
        revision: 1,
        endAt: '2026-10-22T00:00:00Z',
      })
    ).status,
    400,
  );
  const updated = await member(`/calendar-events/${event.id}`, 'PATCH', {
    revision: 1,
    title: '更新済み',
  });
  assert.equal(updated.status, 200);
  event = updated.body.data;
  assert.equal(event.revision, 2);
  assert.equal(
    (await member(`/calendar-events/${event.id}`, 'PATCH', { revision: 1, title: '古い更新' }))
      .status,
    409,
  );
  assert.equal((await member(`/calendar-events/${event.id}?revision=1`, 'DELETE')).status, 409);
  const faq = (await admin('/announcements', 'POST', { kind: 'faq', title: 'FAQ確認' })).body.data;
  assert.equal((await member(`/announcements/${faq.id}`, 'PATCH', { title: '書換' })).status, 403);
  assert.equal((await member(`/announcements/${faq.id}`, 'DELETE')).status, 403);
  assert.equal((await member(`/announcements/${faq.id}/tags`, 'PUT', { tagIds: [] })).status, 403);
  assert.equal(
    (await member(`/announcements/${faq.id}/attachments`, 'POST', { fileId: tag.id })).status,
    403,
  );
  assert.equal(
    (await admin('/announcements', 'POST', { kind: 'calendar', title: '不正種別' })).status,
    403,
  );
  await admin(`/announcement-tags/${tag.id}`, 'PATCH', { archived: true });
  assert.equal(
    (
      await member(`/calendar-events/${event.id}`, 'PATCH', {
        revision: 2,
        memo: '保持確認',
        tagIds: [tag.id],
      })
    ).status,
    200,
  );
  event = (await member(`/calendar-events/${event.id}`)).body.data;
  assert.equal(
    (await member('/calendar-events', 'POST', { ...input, tagIds: [tag.id] })).status,
    400,
  );
  await admin(`/user-groups/${group.id}`, 'PATCH', { canEditHomeCalendar: false });
  assert.equal((await member('/home/permissions')).body.data.calendarEdit, false);
  assert.equal(
    (
      await member(`/calendar-events/${event.id}`, 'PATCH', {
        revision: event.revision,
        memo: '失効後',
      })
    ).status,
    403,
  );
  assert.equal((await member(`/calendar-events/${event.id}`)).status, 200);
  const groupB = (
    await admin('/user-groups', 'POST', {
      name: 'Calendar integration B',
      canEditHomeCalendar: true,
    })
  ).body.data;
  await admin(`/user-groups/${groupB.id}/members`, 'POST', { accountId: memberId });
  const effective = (await member('/home/permissions')).body.data;
  assert.equal(effective.boardEdit, true);
  assert.equal(effective.calendarEdit, true);
  assert.equal(effective.faqEdit, false);
  assert.equal(
    (await member(`/user-groups/${group.id}`, 'PATCH', { canManageHomeTags: true })).status,
    403,
  );
  const db = new PrismaClient();
  try {
    const logs = await db.auditLog.findMany({ where: { feature: 'カレンダー' } });
    assert.ok(
      logs.some(
        (log) => log.details?.eventId === event.id && log.details.changedFields?.includes('memo'),
      ),
    );
    const actor = (await admin('/auth/me')).body.data.id;
    await assert.rejects(
      db.calendarEvent.create({
        data: {
          ...input,
          startAt: new Date('2026-10-24T10:00:00Z'),
          endAt: new Date('2026-10-24T09:00:00Z'),
          createdById: actor,
          updatedById: actor,
        },
      }),
    );
    const prefix = 'calendar-limit-fixture-';
    await db.calendarEvent.createMany({
      data: Array.from({ length: 2001 }, (_, i) => ({
        title: prefix + i,
        startAt: new Date('2026-10-24T01:00:00Z'),
        endAt: new Date('2026-10-24T02:00:00Z'),
        memo: '',
        createdById: actor,
        updatedById: actor,
      })),
    });
    assert.equal(
      (await admin(range('2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z', prefix))).status,
      422,
    );
    const first = await db.calendarEvent.findFirst({ where: { title: prefix + '0' } });
    await db.calendarEvent.delete({ where: { id: first.id } });
    const full = await admin(range('2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z', prefix));
    assert.equal(full.status, 200);
    assert.equal(full.body.data.length, 2000);
    await db.calendarEvent.deleteMany({ where: { title: { startsWith: prefix } } });
  } finally {
    await db.$disconnect();
  }
  assert.equal(
    (await member(`/calendar-events/${event.id}?revision=${event.revision}`, 'DELETE')).status,
    200,
  );
  assert.equal((await member(`/calendar-events/${event.id}`)).status, 404);
  await admin(`/announcement-tags/${tag.id}`, 'DELETE');
  await admin(`/announcements/${faq.id}`, 'DELETE');
  await admin(`/user-groups/${group.id}`, 'DELETE');
  await admin(`/user-groups/${groupB.id}`, 'DELETE');
});
