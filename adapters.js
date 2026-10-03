/**
 * CPA 各插件的适配层。
 *
 * 四个插件（workbuddy / trae / qoder / zcode）的接口路径与返回结构**各不相同**，
 * 全部差异收敛在这个文件里，上层（host 路由、面板）只看统一形状。
 *
 * 实测到的差异（2026-10-02）：
 *
 * | 能力        | workbuddy | trae      | qoder | zcode |
 * |-------------|-----------|-----------|-------|-------|
 * | 账号数      | 3         | 2         | 1     | 1     |
 * | 余额        | 积分      | 积分池    | 积分  | token |
 * | 签到状态    | 部分账号  | 可靠      | 无    | 无    |
 * | 签到        | ✓         | ✓         | ✓     | ✗     |
 * | 自动签到    | ✓         | ✗         | ✓     | ✗     |
 * | 任务中心    | ✓         | ✗         | ✗     | ✗     |
 *
 * 插件自己的「选用」接口**不再使用**：实测对请求去向零影响
 * （`/v0/management/plugins/<id>/select` 只改插件面板显示的状态）。
 * 真正决定用哪个账号的是 auth 文件的 `priority`，且**必须用
 * `PATCH /v0/management/auth-files/fields` 写**，直接改文件不生效。
 *
 * `/credits` 有三种写法：
 *  - workbuddy / qoder / zcode: `{accounts:[{auth_index, credits:{packages,total_*}}]}`
 *  - trae:                      `{provider, results:[{auth_index, credits_pool_remain, checked_in, ...}]}`
 * @module dsh-cpa-switch/adapters
 */

/**
 * 每个插件的能力声明 + 解析器。
 *
 * `capabilities` 决定面板显示哪些按钮 —— 不支持的不显示，
 * 而不是显示一个点了没反应的。
 */
export const PLUGIN_ADAPTERS = {
  workbuddy: {
    label: 'WorkBuddy',
    /** 余额单位：积分。 */
    unit: 'credits',
    capabilities: {
      credits: true,
      checkin: true,
      tasks: true,
      autoCheckin: true,
      school: true,
      import: true,
    },
    /** 余额接口（不带 auth_index 时一次给全部）。 */
    creditsPath: () => '/v0/management/plugins/workbuddy/credits',
    /**
     * 解析余额。
     * `{accounts:[{auth_index, credits:{packages, total_remain, total_used, total_size}}]}`
     */
    parseCredits: (payload) => {
      const map = new Map();
      for (const item of payload?.accounts ?? []) {
        if (item?.credits === undefined || item.credits === null) continue;
        map.set(item.auth_index, {
          remain: Number(item.credits.total_remain ?? 0),
          used: Number(item.credits.total_used ?? 0),
          size: Number(item.credits.total_size ?? 0),
          packCount: Number(item.credits.pack_count ?? (item.credits.packages ?? []).length),
          packages: item.credits.packages ?? [],
          fetchedAt: item.credits.fetched_at,
        });
      }
      return map;
    },
    /**
     * 签到状态。
     *
     * ⚠️ **不可靠**：`/accounts` 的 `checkin` 字段只有部分账号有，
     * 且实测多个账号返回完全相同的数据（疑似缓存串号），
     * 所以只当作"有就显示、没有就留空"，绝不据此推断"未签到"。
     */
    parseCheckin: (account) => {
      const c = account?.checkin;
      if (c === undefined || c === null) return undefined;
      return {
        checkedToday: c.today_checked_in === true,
        streakDays: Number(c.streak_days ?? 0),
        totalCredits: Number(c.total_credits ?? 0),
        activityName: c.activity_name,
      };
    },
  },

  trae: {
    label: 'Trae',
    unit: 'credits',
    capabilities: {
      credits: true,
      checkin: true,
      tasks: false,
      autoCheckin: false,
      school: false,
      import: false,
    },
    creditsPath: () => '/v0/management/plugins/trae/credits',
    /**
     * 解析余额。
     * `{provider, results:[{auth_index, credits_pool_remain, checked_in, ...}]}`
     *
     * 注意：trae 用 `credits_pool_remain` 而不是 `total_remain`，
     * 且 `remain_known=false` 时 `total_remain` 是 0（**不代表没额度**，是"未知"）。
     */
    parseCredits: (payload) => {
      const map = new Map();
      for (const item of payload?.results ?? []) {
        map.set(item.auth_index, {
          remain: Number(item.credits_pool_remain ?? 0),
          used: 0,
          size: Number(item.credits_pool_remain ?? 0),
          packCount: 0,
          packages: [],
          unlimited: item.credits_pool_unlimited === true,
          remainKnown: item.credits_pool_known === true,
          plan: item.plan,
          // trae 把签到状态放在这里 —— 这是**可靠**的签到信号
          checkedIn: item.checked_in === true,
          checkinCredits: item.checkin_credits,
        });
      }
      return map;
    },
    /** trae 的签到状态是**可靠**的（`checked_in` 明确字段）。 */
    parseCheckin: (account, creditEntry) => {
      if (creditEntry?.checkedIn === undefined) return undefined;
      return {
        checkedToday: creditEntry.checkedIn === true,
        streakDays: undefined,
        totalCredits: undefined,
        checkinCredits: creditEntry.checkinCredits,
      };
    },
  },

  qoder: {
    label: 'Qoder',
    unit: 'credits',
    capabilities: {
      credits: true,
      checkin: true,
      tasks: false,
      autoCheckin: true,
      school: false,
      import: true,
    },
    creditsPath: () => '/v0/management/plugins/qoder/credits',
    /** 与 workbuddy 同构。 */
    parseCredits: (payload) => {
      const map = new Map();
      for (const item of payload?.accounts ?? []) {
        if (item?.credits === undefined || item.credits === null) continue;
        map.set(item.auth_index, {
          remain: Number(item.credits.total_remain ?? 0),
          used: Number(item.credits.total_used ?? 0),
          size: Number(item.credits.total_size ?? 0),
          packCount: Number(item.credits.pack_count ?? (item.credits.packages ?? []).length),
          packages: item.credits.packages ?? [],
          fetchedAt: item.credits.fetched_at,
        });
      }
      return map;
    },
    parseCheckin: () => undefined,
  },

  zcode: {
    label: 'ZCode',
    /** ⚠️ 单位是 token，不是积分 —— 不能与其它插件混算总额。 */
    unit: 'tokens',
    capabilities: {
      credits: true,
      checkin: false,
      tasks: false,
      autoCheckin: false,
      school: false,
      import: false,
    },
    creditsPath: () => '/v0/management/plugins/zcode/credits',
    parseCredits: (payload) => {
      const map = new Map();
      for (const item of payload?.accounts ?? []) {
        if (item?.credits === undefined || item.credits === null) continue;
        map.set(item.auth_index, {
          remain: Number(item.credits.total_remain ?? 0),
          used: Number(item.credits.total_used ?? 0),
          size: Number(item.credits.total_size ?? 0),
          packCount: Number(item.credits.pack_count ?? (item.credits.packages ?? []).length),
          packages: item.credits.packages ?? [],
          fetchedAt: item.credits.fetched_at,
        });
      }
      return map;
    },
    parseCheckin: () => undefined,
  },
};

/** 面板展示顺序。 */
export const PLUGIN_ORDER = ['workbuddy', 'trae', 'qoder', 'zcode'];

/** 写操作在各插件下的路径；`null` 表示该插件不支持。 */
export const ACTION_PATHS = {
  workbuddy: {
    checkin: '/v0/management/plugins/workbuddy/checkin',
    tasks: '/v0/management/plugins/workbuddy/tasks/run',
    refresh: '/v0/management/plugins/workbuddy/refresh',
    trial: '/v0/management/plugins/workbuddy/trial',
    import: '/v0/management/plugins/workbuddy/import',
  },
  trae: {
    checkin: '/v0/management/plugins/trae/checkin',
    refresh: '/v0/management/plugins/trae/refresh',
    release: '/v0/management/plugins/trae/release',
  },
  qoder: {
    checkin: '/v0/management/plugins/qoder/checkin',
    refresh: '/v0/management/plugins/qoder/refresh',
    import: '/v0/management/plugins/qoder/import',
    claimPro: '/v0/management/plugins/qoder/claim-pro',
  },
  zcode: {
    refresh: '/v0/management/plugins/zcode/refresh',
    claim: '/v0/management/plugins/zcode/claim',
  },
};

/**
 * 自动签到开关的路径（只有 workbuddy / qoder 有）。
 *
 * ⚠️ **读和写不是同一个接口**：
 *  - **读**：`checkin_auto` 在 `/accounts` 的**顶层**。
 *    未显式设置过时 `/config` 里根本没有这个键，所以读 `/config` 会永远拿到
 *    undefined、开关永远显示"关"（而真实值恰好是 false 时看不出 bug）。
 *  - **写**：`PATCH /v0/management/plugins/<id>/config`，body `{checkin_auto: bool}`。
 *
 * ⚠️ 曾经写成 `POST /checkin/config` —— 那个路径**根本不存在**（404），
 *    所以"切换自动签到"从来没成功过。正确路径是 PATCH `/config`。
 */
export const AUTO_CHECKIN_PATHS = {
  workbuddy: {
    /** 读：从 `/accounts` 顶层取 `field`。 */
    readFrom: '/v0/management/plugins/workbuddy/accounts',
    write: '/v0/management/plugins/workbuddy/config',
    field: 'checkin_auto',
  },
  qoder: {
    readFrom: '/v0/management/plugins/qoder/accounts',
    write: '/v0/management/plugins/qoder/config',
    field: 'checkin_auto',
  },
};

/**
 * 各插件通用的 `scheduler_mode` 配置。
 *
 * ⚠️ **这是让账号优先级生效的前提**：
 *  - `off`      → 交给 CPA 内置调度器（`fill-first` + `priority` 生效）✅
 *  - `credits`  → **插件自己选号**，挑剩余额度最多的，**完全无视 priority** ❌
 *
 *  实测：`credits` 模式下四号优先级 100/90/80/70 形同虚设，
 *  请求一直落在余量最多的那个号上（新号），而不是优先级最高的 cherry。
 *
 *  改完**必须重启 CPA** 才生效（配置不热加载）。
 */
export const PLUGIN_CONFIG_PATH = (plugin) => `/v0/management/plugins/${plugin}/config`;

/** 插件应设的调度模式。 */
export const SCHEDULER_MODE = 'off';

/**
 * 把某插件的账号列表 + 余额合并成统一形状。
 * @param plugin - 插件 id。
 * @param accountsPayload - `/accounts` 的原始返回。
 * @param creditsPayload - `/credits` 的原始返回（可为空）。
 * @returns 统一形状的账号数组。
 */
export function normalizeAccounts(plugin, accountsPayload, creditsPayload) {
  const adapter = PLUGIN_ADAPTERS[plugin];
  if (adapter === undefined) return [];

  const creditsMap = creditsPayload === undefined ? new Map() : adapter.parseCredits(creditsPayload);
  const rawList = Array.isArray(accountsPayload?.accounts)
    ? accountsPayload.accounts
    : Array.isArray(accountsPayload?.results)
      ? accountsPayload.results
      : [];

  return rawList.map((account) => {
    const credit = creditsMap.get(account.auth_index);
    return {
      authIndex: account.auth_index,
      /**
       * 凭据文件名（`workbuddy-<uid>.json` 之类）。
       *
       * 这是**跨接口的通用标识**：`/v0/management/auth-files` 里的 `name`
       * 与它逐字相同，用它才能把"账号"和"真实请求统计"对上。
       * （`auth_index` 两边也一致，但 `auth_id` 更稳定、可读。）
       */
      authId: account.auth_id,
      nickname: account.nickname ?? account.label ?? account.auth_index,
      disabled: account.disabled === true,
      exhausted: account.exhausted === true,
      plan: account.plan,
      region: account.region,
      status: account.status,
      credits: credit ?? null,
      checkin: adapter.parseCheckin(account, credit),
    };
  });
}