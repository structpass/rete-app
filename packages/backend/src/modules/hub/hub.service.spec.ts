import { HubService } from './hub.service';

describe('HubService', () => {
  let service: HubService;
  // env はプロセス共有のため、テスト前後で REFERENCE_APP_URL / REFERENCE_OIDC_READY を保存・復元する。
  const ORIGINAL_REFERENCE_URL = process.env.REFERENCE_APP_URL;
  const ORIGINAL_REFERENCE_READY = process.env.REFERENCE_OIDC_READY;
  const ORIGINAL_GMIS_URL = process.env.GMIS_APP_URL;
  const ORIGINAL_GMIS_READY = process.env.GMIS_OIDC_READY;

  beforeEach(() => {
    service = new HubService();
  });

  afterEach(() => {
    if (ORIGINAL_REFERENCE_URL === undefined) {
      delete process.env.REFERENCE_APP_URL;
    } else {
      process.env.REFERENCE_APP_URL = ORIGINAL_REFERENCE_URL;
    }
    if (ORIGINAL_REFERENCE_READY === undefined) {
      delete process.env.REFERENCE_OIDC_READY;
    } else {
      process.env.REFERENCE_OIDC_READY = ORIGINAL_REFERENCE_READY;
    }
    if (ORIGINAL_GMIS_URL === undefined) {
      delete process.env.GMIS_APP_URL;
    } else {
      process.env.GMIS_APP_URL = ORIGINAL_GMIS_URL;
    }
    if (ORIGINAL_GMIS_READY === undefined) {
      delete process.env.GMIS_OIDC_READY;
    } else {
      process.env.GMIS_OIDC_READY = ORIGINAL_GMIS_READY;
    }
  });

  describe('getMenu', () => {
    it('exposes the exact loopback demo URL in development only', () => {
      const previousUrl = process.env.GMIS_DEMO_URL;
      const previousEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'development';
        process.env.GMIS_DEMO_URL = 'http://127.0.0.1:4177';
        expect(service.getMenu().items.at(-1)).toMatchObject({
          key: 'gmis-demo',
          href: process.env.GMIS_DEMO_URL,
          available: true,
        });
        process.env.NODE_ENV = 'production';
        expect(service.getMenu().items.some((item) => item.key === 'gmis-demo')).toBe(false);
        process.env.NODE_ENV = 'development';
        process.env.GMIS_DEMO_URL = 'https://example.test';
        expect(service.getMenu().items.some((item) => item.key === 'gmis-demo')).toBe(false);
      } finally {
        if (previousUrl === undefined) delete process.env.GMIS_DEMO_URL;
        else process.env.GMIS_DEMO_URL = previousUrl;
        if (previousEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnv;
      }
    });
    it('tasks・reference・gmis の 3 導線をこの順で返すこと', () => {
      const keys = service.getMenu().items.map((i) => i.key);
      expect(keys).toEqual(['tasks', 'reference', 'gmis']);
    });

    it('tasks は internal / rete カテゴリで未接続（available=false）であること', () => {
      const tasks = service.getMenu().items.find((i) => i.key === 'tasks')!;
      expect(tasks.type).toBe('internal');
      expect(tasks.category).toBe('rete');
      expect(tasks.href).toBe('/tasks');
      expect(tasks.available).toBe(false);
    });

    it('REFERENCE_APP_URL 未設定時、reference は localhost:3000 にフォールバックし available=false', () => {
      delete process.env.REFERENCE_APP_URL;
      delete process.env.REFERENCE_OIDC_READY;
      const reference = service.getMenu().items.find((i) => i.key === 'reference')!;
      expect(reference.href).toBe('http://localhost:3000');
      expect(reference.available).toBe(false);
    });

    it('URL 設定済みでも REFERENCE_OIDC_READY 未設定なら available=false（連携完成までグレー）', () => {
      // URL があるだけでは導線を有効化しない。OIDC RP 連携が完成するまで「準備中」に保つ。
      process.env.REFERENCE_APP_URL = 'https://ref.example.com';
      delete process.env.REFERENCE_OIDC_READY;
      const reference = service.getMenu().items.find((i) => i.key === 'reference')!;
      expect(reference.href).toBe('https://ref.example.com');
      expect(reference.available).toBe(false);
    });

    it('URL 設定 + REFERENCE_OIDC_READY=true で reference は当該 URL を指し external / system で available=true', () => {
      process.env.REFERENCE_APP_URL = 'https://ref.example.com';
      process.env.REFERENCE_OIDC_READY = 'true';
      const reference = service.getMenu().items.find((i) => i.key === 'reference')!;
      expect(reference.href).toBe('https://ref.example.com');
      expect(reference.available).toBe(true);
      expect(reference.type).toBe('external');
      expect(reference.category).toBe('system');
    });

    it('REFERENCE_OIDC_READY=true でも URL が空文字なら available=false（空 href の有効化を防ぐ）', () => {
      process.env.REFERENCE_APP_URL = '';
      process.env.REFERENCE_OIDC_READY = 'true';
      const reference = service.getMenu().items.find((i) => i.key === 'reference')!;
      expect(reference.available).toBe(false);
      // 空文字フォールバックは href にデフォルトが入る（?? は null/undefined のみ捕捉のため空文字は素通り → 既存挙動を固定）。
      expect(reference.href).toBe('');
    });

    it('READY=true でも危険スキーム（javascript:/file:）の URL は available=false（open redirect/XSS 防御）', () => {
      // href は frontend で window.location.href + probe fetch に渡るため、http(s) 以外は連携不可に倒す。
      process.env.REFERENCE_OIDC_READY = 'true';
      for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
        process.env.REFERENCE_APP_URL = bad;
        const reference = service.getMenu().items.find((i) => i.key === 'reference')!;
        expect(reference.available).toBe(false);
      }
    });

    it('http / https スキームは従来どおり available=true（防御で正常系を巻き込まない）', () => {
      process.env.REFERENCE_OIDC_READY = 'true';
      for (const ok of ['http://localhost:3000', 'https://ref.example.com']) {
        process.env.REFERENCE_APP_URL = ok;
        const reference = service.getMenu().items.find((i) => i.key === 'reference')!;
        expect(reference.available).toBe(true);
      }
    });

    // d1171: 報告管理（gmis）の導線。Reference と同じく env 駆動で、READY が立つまでグレーに保つ。
    it('gmis は external / system で、GMIS_OIDC_READY 未設定なら available=false', () => {
      delete process.env.GMIS_OIDC_READY;
      process.env.GMIS_APP_URL = 'https://gmis.example.com';
      const gmis = service.getMenu().items.find((i) => i.key === 'gmis')!;
      expect(gmis.type).toBe('external');
      expect(gmis.category).toBe('system');
      expect(gmis.href).toBe('https://gmis.example.com');
      expect(gmis.available).toBe(false);
    });

    it('GMIS_APP_URL 未設定時は 127.0.0.1:4188 にフォールバックし available=false', () => {
      delete process.env.GMIS_APP_URL;
      delete process.env.GMIS_OIDC_READY;
      const gmis = service.getMenu().items.find((i) => i.key === 'gmis')!;
      expect(gmis.href).toBe('http://127.0.0.1:4188');
      expect(gmis.available).toBe(false);
    });

    it('URL 設定 + GMIS_OIDC_READY=true で gmis は当該 URL を指し available=true', () => {
      process.env.GMIS_APP_URL = 'https://gmis.example.com';
      process.env.GMIS_OIDC_READY = 'true';
      const gmis = service.getMenu().items.find((i) => i.key === 'gmis')!;
      expect(gmis.href).toBe('https://gmis.example.com');
      expect(gmis.available).toBe(true);
    });

    it('GMIS_OIDC_READY=true でも危険スキームの URL は available=false（open redirect/XSS 防御）', () => {
      process.env.GMIS_OIDC_READY = 'true';
      for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url']) {
        process.env.GMIS_APP_URL = bad;
        const gmis = service.getMenu().items.find((i) => i.key === 'gmis')!;
        expect(gmis.available).toBe(false);
      }
    });

    // d1198: 表示名は d1154 で決めた「報告管理」に完全一致させる。接続可否にかかわらず同じ名前にする
    // （在庫管理の隣に出る正式導線のラベルが、連携の進み具合で揺れない）。
    it('gmis の表示名は接続可・不可のどちらでも「報告管理」に完全一致する（d1198）', () => {
      for (const ready of [undefined, 'true']) {
        if (ready === undefined) {
          delete process.env.GMIS_OIDC_READY;
        } else {
          process.env.GMIS_OIDC_READY = ready;
        }
        process.env.GMIS_APP_URL = 'https://gmis.example.com';
        const gmis = service.getMenu().items.find((i) => i.key === 'gmis')!;
        expect(gmis.label).toBe('報告管理');
        // キー・並び順・URL は変えない（d1198 の維持条件）。
        expect(gmis.type).toBe('external');
        expect(gmis.category).toBe('system');
        expect(gmis.href).toBe('https://gmis.example.com');
      }
      // 在庫管理（reference）の直後に並ぶ。
      const keys = service.getMenu().items.map((i) => i.key);
      expect(keys.indexOf('gmis')).toBe(keys.indexOf('reference') + 1);
    });
  });
});
