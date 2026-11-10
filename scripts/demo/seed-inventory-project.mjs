import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  people,
  spaces,
  tasks,
  threads,
  notices,
  faqs,
  events,
  id,
  at,
  snapshot,
  projectName,
} from './inventory-scenario.mjs';
import { documentDefs, textAssets, assetPublishedAt } from './inventory-documents.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const backendRequire = createRequire(
  new URL('../../packages/backend/package.json', import.meta.url),
);
const account = (key) => people.find((p) => p.key === key).id;
const space = (key) => spaces.find((s) => s.key === key).id;
const html = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const para = (s) => '<p>' + html(s) + '</p>';
const mime = (name) =>
  name.endsWith('.xlsx')
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : name.endsWith('.pdf')
      ? 'application/pdf'
      : name.endsWith('.csv')
        ? 'text/csv'
        : 'text/markdown';

export function assertLocalTarget(env) {
  if (!['development', 'test'].includes(env.NODE_ENV))
    throw new Error('開発・試験環境を明示してください。');
  const url = new URL(env.DATABASE_URL);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  )
    throw new Error('ローカルPostgreSQLだけに投入できます。');
  if (
    /prod|production|live/i.test(decodeURIComponent(url.pathname)) ||
    ['', '/', '/postgres', '/template0', '/template1'].includes(url.pathname)
  )
    throw new Error('本番名・管理用データベースには投入できません。');
  return url;
}

export async function validateScenario() {
  const keys = new Set(people.map((p) => p.key));
  const channels = new Map(spaces.map((s) => [s.key, s]));
  for (const task of tasks) {
    if (!keys.has(task.assignee) || !channels.has(task.space) || at(task.start) > at(task.due))
      throw new Error('タスクの担当・場・日付が不正: ' + task.key);
    if (task.status === 'DONE' && !task.comment) throw new Error('完了の顛末がありません。');
  }
  for (const t of threads) {
    if (!channels.has(t.space) || !keys.has(t.author)) throw new Error('会話の参照が不正です。');
    if (
      !channels.get(t.space).customer &&
      t.messages.some((m) => !people.find((p) => p.key === m[0])?.internal)
    )
      throw new Error('顧客が社内の会話に参加しています。');
    for (const m of t.messages)
      if (!keys.has(m[0]) || at(m[1], m[2]) > at(snapshot, '23:59'))
        throw new Error('会話の人物・時刻が不正です。');
  }
  for (const e of events)
    if (at(e[0], e[1]) >= at(e[0], e[2])) throw new Error('予定の終了が開始以前です。');
  for (const doc of documentDefs) {
    for (const name of doc.assets) {
      if (!(name in textAssets)) {
        const bytes = await readFile(join(here, 'assets', name));
        if (name.endsWith('.pdf') && bytes.subarray(0, 5).toString() !== '%PDF-')
          throw new Error('PDF実体が不正です。');
        if (name.endsWith('.xlsx') && bytes.subarray(0, 2).toString() !== 'PK')
          throw new Error('表計算の実体が不正です。');
      }
    }
  }
  return {
    snapshot,
    people: people.length,
    channels: spaces.length,
    tasks: tasks.length,
    threads: threads.length,
    messages: threads.reduce((n, t) => n + t.messages.length, 1),
    notices: notices.length,
    faqs: faqs.length,
    events: events.length,
    files: documentDefs.length,
    versions: documentDefs.reduce((n, d) => n + d.assets.length, 0),
  };
}

// 同一データの再投入は既存行を変更しない。利用者の試行や追記を消さない。
const keep = (tx, model, where, data) => tx[model].upsert({ where, create: data, update: {} });

export async function seedInventoryProject(prisma, storageRoot) {
  const root = resolve(storageRoot);
  const bytesByAsset = new Map();
  for (const doc of documentDefs)
    for (const name of doc.assets)
      if (!bytesByAsset.has(name))
        bytesByAsset.set(
          name,
          name in textAssets
            ? Buffer.from(textAssets[name], 'utf8')
            : await readFile(join(here, 'assets', name)),
        );
  const { hash } = backendRequire('@node-rs/argon2');
  const passwordHash = await hash(process.env.SEED_DEMO_PASSWORD ?? 'ReteDemo1234!');
  // 実体は固有UUID配下へ先に用意する。失敗時はDBを確定せず、既存ファイルを上書きしない。
  for (let d = 0; d < documentDefs.length; d++) {
    for (let v = 0; v < documentDefs[d].assets.length; v++) {
      const target = join(root, id(4000 + d), id(5000 + d * 10 + v));
      const bytes = bytesByAsset.get(documentDefs[d].assets[v]);
      await mkdir(dirname(target), { recursive: true });
      try {
        await writeFile(target, bytes, { flag: 'wx' });
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (!(await readFile(target)).equals(bytes))
          throw new Error('既存の案件ファイルが変更されています。上書きせず停止しました。');
      }
    }
  }
  return prisma.$transaction(
    async (tx) => {
      // 並行したseed同士で、採番タスクが重複しないよう直列化する。
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(993, 1)');
      for (const p of people) {
        const existing = await tx.account.findFirst({
          where: { OR: [{ id: p.id }, { email: p.email }] },
        });
        if (existing && (existing.id !== p.id || existing.email !== p.email))
          throw new Error('デモ用識別子が既存アカウントと衝突しました。');
        const [familyName, givenName] = p.name.split(' ');
        await keep(
          tx,
          'account',
          { id: p.id },
          {
            id: p.id,
            email: p.email,
            passwordHash,
            name: p.name,
            familyName,
            givenName,
            role: 'MEMBER',
            createdAt: at('2026-10-19'),
          },
        );
      }
      await keep(
        tx,
        'organization',
        { id: id(200) },
        { id: id(200), name: '青凪システム｜北斗機材案件', sortOrder: -10 },
      );
      await keep(
        tx,
        'project',
        { id: id(201) },
        {
          id: id(201),
          organizationId: id(200),
          name: '在庫管理システム｜設計・導入',
          sortOrder: 0,
        },
      );
      await keep(
        tx,
        'organization',
        { id: id(202) },
        { id: id(202), name: '北斗機材｜共同設計', sortOrder: -9 },
      );
      await keep(
        tx,
        'project',
        { id: id(203) },
        {
          id: id(203),
          organizationId: id(202),
          name: '在庫管理｜仕様確認・導入準備',
          sortOrder: 0,
        },
      );
      for (const [i, s] of spaces.entries())
        await keep(
          tx,
          'space',
          { id: s.id },
          {
            id: s.id,
            kind: 'CHANNEL',
            projectId: id(s.customer ? 203 : 201),
            name: s.name,
            sortOrder: i,
          },
        );
      for (const p of people) {
        // 一覧からたどれるよう社内と共有の組織を分離し、顧客に社内の祖先スコープを与えない。
        const scopes = p.internal
          ? [
              { scopeType: 'ORGANIZATION', scopeId: id(200) },
              { scopeType: 'ORGANIZATION', scopeId: id(202) },
              { scopeType: 'PROJECT', scopeId: id(201) },
              { scopeType: 'PROJECT', scopeId: id(203) },
            ]
          : [
              { scopeType: 'ORGANIZATION', scopeId: id(202) },
              { scopeType: 'PROJECT', scopeId: id(203) },
              ...spaces
                .filter((s) => s.customer)
                .map((s) => ({ scopeType: 'CHANNEL', scopeId: s.id })),
            ];
        for (const scope of scopes)
          await keep(
            tx,
            'membership',
            { accountId_scopeType_scopeId: { accountId: p.id, ...scope } },
            { accountId: p.id, ...scope, role: p.key === 'saeki' ? 'ADMIN' : 'MEMBER' },
          );
      }
      await keep(
        tx,
        'userGroup',
        { id: id(210) },
        {
          id: id(210),
          name: '北斗機材案件｜案内担当',
          canEditHomeBoard: true,
          canEditHomeCalendar: true,
          canEditHomeFaq: true,
          canManageHomeTags: true,
        },
      );
      await keep(
        tx,
        'userGroupMember',
        { groupId_accountId: { groupId: id(210), accountId: account('saeki') } },
        { groupId: id(210), accountId: account('saeki') },
      );
      for (const [i, name] of ['合意済み', '確認中', '受領資料', '社内検討'].entries()) {
        const tag = await keep(
          tx,
          'tag',
          { name },
          {
            id: id(6000 + i),
            name,
            icon: 'FileText',
            color: ['emerald', 'amber', 'blue', 'slate'][i],
          },
        );
        bytesByAsset.set('tag:' + name, tag.id);
      }
      const latestVersions = new Map();
      const folderIds = new Map();
      for (const [d, doc] of documentDefs.entries()) {
        const folderKey = doc.space + ':' + doc.folder;
        if (!folderIds.has(folderKey)) {
          const folderId = id(3000 + d);
          await keep(
            tx,
            'folder',
            { id: folderId },
            {
              id: folderId,
              name: doc.folder,
              spaceId: space(doc.space),
              sortOrder: d,
              createdById: account(doc.uploader),
              createdAt: at('2026-10-29'),
            },
          );
          folderIds.set(folderKey, folderId);
        }
        const fileId = id(4000 + d);
        await keep(
          tx,
          'file',
          { id: fileId },
          {
            id: fileId,
            name: doc.name,
            folderId: folderIds.get(folderKey),
            createdAt: new Date(assetPublishedAt(doc.key, 0)),
            updatedAt: new Date(assetPublishedAt(doc.key, doc.assets.length - 1)),
          },
        );
        for (const [v, asset] of doc.assets.entries()) {
          const versionId = id(5000 + d * 10 + v);
          await keep(
            tx,
            'fileVersion',
            { id: versionId },
            {
              id: versionId,
              fileId,
              versionNo: v + 1,
              storageKey: fileId + '/' + versionId,
              byteSize: BigInt(bytesByAsset.get(asset).length),
              mimeType: mime(asset),
              uploadedById: account(doc.uploader),
              createdAt: new Date(assetPublishedAt(doc.key, v)),
            },
          );
          latestVersions.set(doc.key, versionId);
        }
        await keep(
          tx,
          'fileTag',
          { fileId_tagId: { fileId, tagId: bytesByAsset.get('tag:' + doc.tag) } },
          { fileId, tagId: bytesByAsset.get('tag:' + doc.tag) },
        );
      }
      const categoryIds = new Map();
      const taskIds = new Map();
      for (const task of tasks) {
        const categoryKey = task.space + ':' + task.category;
        if (!categoryIds.has(categoryKey)) {
          const category = await keep(
            tx,
            'category',
            { spaceId_name: { spaceId: space(task.space), name: task.category } },
            { spaceId: space(task.space), name: task.category, sortOrder: categoryIds.size },
          );
          categoryIds.set(categoryKey, category.id);
        }
        // 固有の作成履歴をインポートキーとし、題名を編集しても再実行でタスクを増やさない。
        const origin = await tx.taskActivity.findUnique({ where: { id: id(8000 + task.index) } });
        let saved;
        if (origin) {
          saved = await tx.task.findUniqueOrThrow({ where: { id: origin.taskId } });
          if (saved.spaceId !== space(task.space))
            throw new Error('案件タスクが別の場へ移動されています。投入を止めました。');
        } else {
          saved = await tx.task.create({
            data: {
              title: task.title,
              description: para(task.description),
              status: task.status,
              tenmatsu: task.status === 'DONE' ? para(task.comment) : null,
              spaceId: space(task.space),
              categoryId: categoryIds.get(categoryKey),
              assigneeId: account(task.assignee),
              ownerId: account('saeki'),
              startDate: at(task.start),
              dueDate: at(task.due, '17:00'),
              sortOrder: task.index,
              createdAt: at('2026-10-27'),
              updatedAt: at('2026-10-30', '17:00'),
            },
          });
          await tx.taskActivity.create({
            data: {
              id: id(8000 + task.index),
              taskId: saved.id,
              actorAccountId: account('saeki'),
              field: 'thread',
              toLabel: task.title,
              createdAt: at('2026-10-27'),
            },
          });
        }
        taskIds.set(task.key, saved.id);
        await keep(
          tx,
          'taskComment',
          { id: id(9000 + task.index) },
          {
            id: id(9000 + task.index),
            taskId: saved.id,
            authorId: account(task.assignee),
            body: para(task.comment),
            createdAt: at('2026-10-30', '16:00'),
          },
        );
      }
      const threadIds = new Map();
      for (const [i, t] of threads.entries()) {
        const themeId = id(10000 + i);
        threadIds.set(t.key, themeId);
        const last = t.messages.at(-1);
        await keep(
          tx,
          'chatTheme',
          { id: themeId },
          {
            id: themeId,
            title: t.title,
            description: para(t.description),
            tenmatsu: t.closed ? para(last[3]) : null,
            status: t.closed ? 'CLOSED' : 'OPEN',
            authorId: account(t.author),
            spaceId: space(t.space),
            createdAt: at(t.day),
            lastMessageAt:
              t.key === 'screenwork' ? at('2026-10-30', '17:20') : at(last[1], last[2]),
          },
        );
        for (const [j, m] of t.messages.entries())
          await keep(
            tx,
            'chatMessage',
            { id: id(11000 + i * 100 + j) },
            {
              id: id(11000 + i * 100 + j),
              themeId,
              authorId: account(m[0]),
              body: para(m[3]),
              createdAt: at(m[1], m[2]),
            },
          );
      }
      // 自然に関連する資料だけを同じ場の会話・タスクへ添付する。
      const attach = async (n, docKey, target) => {
        const doc = documentDefs.find((d) => d.key === docKey);
        const targetSpace = target.taskKey
          ? tasks.find((t) => t.key === target.taskKey).space
          : threads.find((t) => t.key === target.themeKey).space;
        if (doc.space !== targetSpace) throw new Error('場を越える添付は行いません。');
        await keep(
          tx,
          'attachment',
          { id: id(15000 + n) },
          {
            id: id(15000 + n),
            fileVersionId: latestVersions.get(docKey),
            ...(target.taskKey
              ? { taskId: taskIds.get(target.taskKey) }
              : { themeId: threadIds.get(target.themeKey) }),
            attachedById: account(doc.uploader),
            createdAt: at('2026-10-30', '17:00'),
          },
        );
      };
      await attach(0, 'screens', { themeKey: 'reviewdate' });
      await attach(1, 'questions', { themeKey: 'reviewdate' });
      await attach(2, 'quantity', { themeKey: 'available' });
      await attach(3, 'csv', { themeKey: 'csvnames' });
      await attach(4, 'minutes', { themeKey: 'handoverfiles' });
      await attach(5, 'profiling', { taskKey: 'dictionary' });
      await attach(6, 'roles', { taskKey: 'roles' });
      await attach(7, 'transfer', { taskKey: 'transfer' });
      await attach(8, 'acceptance', { taskKey: 'testplan' });
      await attach(9, 'questions', { taskKey: 'screenreview' });
      // 書き込み後の回答と担当タスクを結び付ける。本文中の番号は実採番から解決する。
      await keep(
        tx,
        'chatMessage',
        { id: id(14999) },
        {
          id: id(14999),
          themeId: threadIds.get('screenwork'),
          authorId: account('saeki'),
          body: para(
            '在庫照会の画面調整はタスク #' +
              taskIds.get('screens') +
              '、数量定義は #' +
              taskIds.get('stock') +
              ' で進めます。11月5日の事前確認までに関連資料をそろえましょう。',
          ),
          createdAt: at('2026-10-30', '17:20'),
        },
      );
      const homeTags = new Map();
      for (const [i, name] of ['レビュー予定', '資料依頼', '合意事項', '進め方'].entries()) {
        const tag = await keep(
          tx,
          'announcementTag',
          { kind_name: { kind: 'board', name } },
          {
            id: id(16000 + i),
            kind: 'board',
            name,
            icon: 'CalendarDays',
            color: ['blue', 'amber', 'emerald', 'slate'][i],
          },
        );
        homeTags.set(name, tag.id);
      }
      const calendarTags = new Map();
      for (const [i, name] of ['レビュー予定', '資料依頼', '合意事項'].entries()) {
        const tag = await keep(
          tx,
          'announcementTag',
          { kind_name: { kind: 'calendar', name } },
          {
            id: id(16100 + i),
            kind: 'calendar',
            name,
            icon: 'CalendarDays',
            color: ['blue', 'amber', 'emerald'][i],
          },
        );
        calendarTags.set(name, tag.id);
      }
      for (const [i, n] of notices.entries()) {
        const annId = id(17000 + i);
        await keep(
          tx,
          'announcement',
          { id: annId },
          {
            id: annId,
            kind: 'board',
            title: n[1],
            body: para('北斗機材 在庫管理システム導入のご案内です。') + n[2],
            position: -100 + i,
            authorId: account('saeki'),
            publishedAt: at(n[0], '17:00'),
            createdAt: at(n[0], '17:00'),
          },
        );
        await keep(
          tx,
          'announcementTagAssignment',
          { announcementId_tagId: { announcementId: annId, tagId: homeTags.get(n[3]) } },
          { announcementId: annId, tagId: homeTags.get(n[3]) },
        );
      }
      for (const [i, f] of faqs.entries())
        await keep(
          tx,
          'announcement',
          { id: id(18000 + i) },
          {
            id: id(18000 + i),
            kind: 'faq',
            title: f[0],
            body: f[1],
            position: -100 + i,
            authorId: account('saeki'),
            publishedAt: at('2026-10-30', '17:00'),
            createdAt: at('2026-10-30', '17:00'),
          },
        );
      for (const [i, e] of events.entries()) {
        const eventId = id(19000 + i);
        await keep(
          tx,
          'calendarEvent',
          { id: eventId },
          {
            id: eventId,
            title: e[3],
            startAt: at(e[0], e[1]),
            endAt: at(e[0], e[2]),
            memo: projectName + '。' + e[4],
            createdById: account('saeki'),
            updatedById: account('saeki'),
            createdAt: at('2026-10-30', '17:00'),
          },
        );
        await keep(
          tx,
          'calendarEventTagAssignment',
          { eventId_tagId: { eventId, tagId: calendarTags.get(e[5]) } },
          { eventId, tagId: calendarTags.get(e[5]) },
        );
      }
      for (const p of people) {
        for (const [i, s] of spaces.filter((s) => p.internal || s.customer).entries())
          await keep(
            tx,
            'userFavorite',
            { accountId_kind_targetRef: { accountId: p.id, kind: 'space', targetRef: s.id } },
            { accountId: p.id, kind: 'space', targetRef: s.id, label: s.name, sortOrder: i },
          );
        await keep(
          tx,
          'deskPreference',
          { accountId: p.id },
          { accountId: p.id, leftPaneRatio: 0.55 },
        );
      }
      // 空の検証DBでも単独利用可能にする。共有DBのテナント名・設定は変えない。
      await keep(
        tx,
        'tenant',
        { id: 'singleton' },
        { id: 'singleton', name: '北斗機材 在庫管理導入（架空案件）', badgeColor: 'green' },
      );
      return { projectName, taskIds: Object.fromEntries(taskIds), files: documentDefs.length };
    },
    { maxWait: 10000, timeout: 60000 },
  );
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const get = (name) => args.find((a) => a.startsWith(name + '='))?.slice(name.length + 1);
  const plan = await validateScenario();
  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', ...plan }, null, 2));
    return;
  }
  assertLocalTarget(process.env);
  const storage = get('--storage-root');
  const backup = get('--backup');
  if (!storage || !backup)
    throw new Error('--storage-root と投入前の --backup を指定してください。');
  if (!(await stat(resolve(backup))).isFile() || (await stat(resolve(backup))).size === 0)
    throw new Error('投入前のバックアップがありません。');
  const { PrismaClient } = backendRequire('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const result = await seedInventoryProject(prisma, storage);
    console.log(JSON.stringify({ mode: 'applied', ...plan, ...result }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    // DBドライバーの例外には接続情報が含まれ得るため、コードだけを表示する。
    console.error(e.code ? '投入失敗: ' + e.code : e.message);
    process.exitCode = 1;
  });
