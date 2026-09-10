// ============================================================
// Hit 值计算引擎
// - 启动时延后 30 秒做首次计算(等数据库连接稳定)
// - 每 24 小时全量重算 + 写入历史
// - 每 60 秒从 user_hit_score 表刷新内存 Map
// - 维护 syzoj.userHitScores 给 username helper 用
// - 暴露 syzoj.recalcHitScores() 给后台手动触发
// ============================================================
let UserHitScore = syzoj.model('user-hit-score');
let UserHitScoreHistory = syzoj.model('user-hit-score-history');
let User = syzoj.model('user');
let JudgeState = syzoj.model('judge_state');
let Problem = syzoj.model('problem');
let ProblemSolution = syzoj.model('problem-solution');
let ContestPlayer = syzoj.model('contest_player');
let ProblemTagMap = syzoj.model('problem_tag_map');
let UserEmailStatus = syzoj.model('user-email-status');
let UserHitSetting = syzoj.model('user-hit-setting');
let Contest = syzoj.model('contest');

const CACHE_REFRESH_INTERVAL_MS = 60 * 1000;
const FULL_RECALC_INTERVAL_MS = 24 * 3600 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;
const HISTORY_RETENTION_DAYS = 90;
const CLEANUP_INTERVAL_MS = 24 * 3600 * 1000;  // 历史清理独立周期: 24小时

// ============ 互斥锁:防止 fullRecalc 并发重入 ============
let _isRecalculating = false;

// 全局内存 Map: userId -> { total, basic_score, contribution_score, contest_score, practice_score }
syzoj.userHitScores = new Map();

// ============ 工具:half-life 衰减 ============
function halfLifeDecay(value, daysSinceActive, halfLifeDays) {
  if (daysSinceActive <= 0) return value;
  let factor = Math.pow(0.5, daysSinceActive / halfLifeDays);
  return value * factor;
}

// ============ 单用户计算(批量数据版本) ============
// 传入预计算的批量查询结果 Map,避免每个用户单独查询
async function calcOneUser(user, batchData) {
  let now = parseInt((new Date()).getTime() / 1000);

  // 解构批量数据
  const {
    emailMap,              // user_id -> UserEmailStatus
    cpCountMap,            // user_id -> contest_player 次数
    acceptedSolMap,        // user_id -> 题解数
    problemsCreatedMap,    // user_id -> 出题数
    contestMaxScoreMap,    // contest_id -> 该比赛最高分
    contestEndTimeMap,     // contest_id -> 比赛结束时间
    userTagCountMap,       // user_id -> 标签覆盖数
    lastAcTimeMap          // user_id -> 最后 AC 时间
  } = batchData;

  // -------- 基础信用分(满分 100,无保底)--------
  let basic = 0;
  try {
    let emailStatus = emailMap.get(user.id);
    if (emailStatus && emailStatus.is_email_verified) basic += 60;
  } catch (e) {}

  if (user.information && String(user.information).trim().length > 0) basic += 10;
  if (user.register_time && now - user.register_time >= 7 * 86400) basic += 15;

  let cpAnyCount = cpCountMap.get(user.id) || 0;
  if (cpAnyCount >= 1) basic += 15;

  if (basic > 100) basic = 100;

  // -------- 社区贡献分(满分 100)--------
  let contribution = 0;
  let acceptedSolutions = acceptedSolMap.get(user.id) || 0;
  contribution += Math.min(acceptedSolutions * 2, 60);

  let problemsCreated = problemsCreatedMap.get(user.id) || 0;
  contribution += Math.min(problemsCreated * 4, 40);

  if (contribution > 100) contribution = 100;

  // -------- 比赛参与分(满分 100,30 天半衰减)--------
  let contestRaw = 0;
  let lastContestEnd = 0; // 最后一次有效参赛的比赛 end_time

  // 查 score > 0 的所有 contest_player 记录
  // 注意:这里仍需按用户查询,因为每个用户的参赛记录不同
  // 但在循环内使用预计算的 Map 而非数据库查询
  let activeCps = await ContestPlayer.createQueryBuilder('cp')
    .where('cp.user_id = :uid', { uid: user.id })
    .andWhere('cp.score > 0')
    .getMany();

  // [v1.5.1] 排除作弊比赛
  const _cheaterMap = syzoj.contestCheaterMap || new Map();
  activeCps = activeCps.filter(cp => {
    const cset = _cheaterMap.get(cp.contest_id);
    return !cset || !cset.has(user.id);
  });

  contestRaw += Math.min(activeCps.length * 2.5, 60);

  // 计算每场的得分率 - 使用预计算的 Map
  let hasGoodScore = false;
  let hasAK = false;
  for (let cp of activeCps) {
    // O(1) Map 查找替代数据库查询
    let maxScore = contestMaxScoreMap.get(cp.contest_id) || 0;
    if (maxScore <= 0) continue;
    let rate = cp.score / maxScore;
    if (rate >= 0.6) hasGoodScore = true;
    if (rate >= 0.9) hasAK = true;

    // O(1) Map 查找替代数据库查询
    let endTime = contestEndTimeMap.get(cp.contest_id);
    if (endTime && endTime > lastContestEnd) lastContestEnd = endTime;
  }
  if (hasGoodScore) contestRaw += 5;
  if (hasAK) contestRaw += 15;

  if (contestRaw > 100) contestRaw = 100;

  // 衰减
  let contestFinal = 0;
  if (lastContestEnd > 0) {
    let daysSince = (now - lastContestEnd) / 86400;
    contestFinal = Math.floor(halfLifeDecay(contestRaw, daysSince, 30));
  }
  if (contestFinal < 0) contestFinal = 0;

  // -------- 题目练习分(满分 100,14 天半衰减只作用于 ac 部分)--------
  let acNum = user.ac_num || 0;
  let acPart = 0;
  if (acNum > 0) {
    acPart = Math.min(Math.floor(Math.log2(acNum + 1) * 2.5), 75);
  }

  // 标签覆盖度(不衰减) - O(1) Map 查找
  let tagCount = userTagCountMap.get(user.id) || 0;
  let tagPart = Math.min(Math.floor(tagCount * 0.2), 25);

  // 最后一次 AC 时间 - O(1) Map 查找
  let lastAcTime = lastAcTimeMap.get(user.id) || 0;

  let acFinal = 0;
  if (acPart > 0 && lastAcTime > 0) {
    let daysSince = (now - lastAcTime) / 86400;
    acFinal = Math.floor(halfLifeDecay(acPart, daysSince, 14));
  }

  let practice = acFinal + tagPart;
  if (practice > 100) practice = 100;
  if (practice < 0) practice = 0;

  let total = basic + contribution + contestFinal + practice;
  if (total > 400) total = 400;
  if (total < 0) total = 0;

  return {
    user_id: user.id,
    total: total,
    basic_score: basic,
    contribution_score: contribution,
    contest_score: contestFinal,
    practice_score: practice
  };
}

// ============ 批量预加载所有需要的数据 ============
async function preloadBatchData() {
  const batchData = {};

  // 1. 所有用户邮箱验证状态
  let allEmailStatus = await UserEmailStatus.find({});
  batchData.emailMap = new Map(allEmailStatus.map(e => [e.user_id, e]));

  // 2. 每个用户的参赛次数
  let cpCountRows = await ContestPlayer.createQueryBuilder()
    .select('user_id', 'uid')
    .addSelect('COUNT(*)', 'cnt')
    .groupBy('user_id')
    .getRawMany();
  batchData.cpCountMap = new Map(cpCountRows.map(r => [r.uid, parseInt(r.cnt) || 0]));

  // 3. 每个用户的题解数
  let acceptedSolRows = await ProblemSolution.createQueryBuilder()
    .select('user_id', 'uid')
    .addSelect('COUNT(*)', 'cnt')
    .where("status = 'accepted'")
    .groupBy('user_id')
    .getRawMany();
  batchData.acceptedSolMap = new Map(acceptedSolRows.map(r => [r.uid, parseInt(r.cnt) || 0]));

  // 4. 每个用户的出题数
  let problemsCreatedRows = await Problem.createQueryBuilder()
    .select('user_id', 'uid')
    .addSelect('COUNT(*)', 'cnt')
    .groupBy('user_id')
    .getRawMany();
  batchData.problemsCreatedMap = new Map(problemsCreatedRows.map(r => [r.uid, parseInt(r.cnt) || 0]));

  // 5. 每场比赛的最高分
  let maxScoreRows = await ContestPlayer.createQueryBuilder()
    .select('contest_id', 'cid')
    .addSelect('MAX(score)', 'max_score')
    .groupBy('contest_id')
    .getRawMany();
  batchData.contestMaxScoreMap = new Map(maxScoreRows.map(r => [r.cid, parseInt(r.max_score) || 0]));

  // 6. 所有比赛的结束时间
  let allContests = await Contest.find({});
  batchData.contestEndTimeMap = new Map(allContests.map(c => [c.id, c.end_time]));

  // 7. 每个用户的标签覆盖数
  let tagCountRows = await ProblemTagMap.createQueryBuilder('m')
    .innerJoin('judge_state', 'js', 'js.problem_id = m.problem_id')
    .leftJoin('judge_state_admin_action', 'a', 'a.judge_id = js.id')
    .where('js.status = :st', { st: 'Accepted' })
    .andWhere('a.judge_id IS NULL')
    .select('js.user_id', 'uid')
    .addSelect('COUNT(DISTINCT m.tag_id)', 'cnt')
    .groupBy('js.user_id')
    .getRawMany();
  batchData.userTagCountMap = new Map(tagCountRows.map(r => [r.uid, parseInt(r.cnt) || 0]));

  // 8. 每个用户的最后 AC 时间
  let lastAcRows = await JudgeState.createQueryBuilder('js')
    .leftJoin('judge_state_admin_action', 'a', 'a.judge_id = js.id')
    .where('js.status = :st', { st: 'Accepted' })
    .andWhere('a.judge_id IS NULL')
    .select('js.user_id', 'uid')
    .addSelect('MAX(js.submit_time)', 'last_ac')
    .groupBy('js.user_id')
    .getRawMany();
  batchData.lastAcTimeMap = new Map(lastAcRows.map(r => [r.uid, parseInt(r.last_ac) || 0]));

  return batchData;
}

// ============ 批量写入当前分数 ============
async function bulkWriteScores(allScores, now) {
  // 使用 QueryBuilder 的 INSERT ... ON DUPLICATE KEY UPDATE 模式
  // 注意:这里需要根据实际数据库类型调整语法(MySQL vs PostgreSQL)
  try {
    const conn = require('typeorm').getConnection();

    for (const scores of allScores) {
      // 使用原生 SQL 进行 upsert
      const upsertSql = `
        INSERT INTO user_hit_score 
          (user_id, total, basic_score, contribution_score, contest_score, practice_score, last_calc_at)
        VALUES 
          (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          total = VALUES(total),
          basic_score = VALUES(basic_score),
          contribution_score = VALUES(contribution_score),
          contest_score = VALUES(contest_score),
          practice_score = VALUES(practice_score),
          last_calc_at = VALUES(last_calc_at)
      `;
      await conn.query(upsertSql, [
        scores.user_id,
        scores.total,
        scores.basic_score,
        scores.contribution_score,
        scores.contest_score,
        scores.practice_score,
        now
      ]);
    }
  } catch (e) {
    syzoj.log('[hit-engine] Bulk write scores failed, falling back to individual saves: ' + e.message);
    // 回退到逐条保存
    for (const scores of allScores) {
      try {
        let row = await UserHitScore.findOne({ where: { user_id: scores.user_id } });
        if (!row) {
          row = await UserHitScore.create();
          row.user_id = scores.user_id;
        }
        row.total = scores.total;
        row.basic_score = scores.basic_score;
        row.contribution_score = scores.contribution_score;
        row.contest_score = scores.contest_score;
        row.practice_score = scores.practice_score;
        row.last_calc_at = now;
        await row.save();
      } catch (innerE) {
        syzoj.log('[hit-engine] Fallback save failed for user ' + scores.user_id + ': ' + innerE.message);
      }
    }
  }
}

// ============ 批量写入历史记录 ============
async function bulkWriteHistories(allHistories) {
  if (allHistories.length === 0) return;

  try {
    const conn = require('typeorm').getConnection();

    // 构建批量 INSERT 语句 (MySQL 语法)
    const columns = ['user_id', 'total', 'basic_score', 'contribution_score', 'contest_score', 'practice_score', 'recorded_at'];
    const placeholders = allHistories.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');

    const insertSql = `INSERT INTO user_hit_score_history (${columns.join(', ')}) VALUES ${placeholders}`;

    const values = allHistories.flatMap(h => [
      h.user_id, h.total, h.basic_score, h.contribution_score,
      h.contest_score, h.practice_score, h.recorded_at
    ]);

    await conn.query(insertSql, values);
  } catch (e) {
    syzoj.log('[hit-engine] Bulk write histories failed, falling back to individual saves: ' + e.message);
    // 回退到逐条保存
    for (const hist of allHistories) {
      try {
        let row = await UserHitScoreHistory.create();
        Object.assign(row, hist);
        await row.save();
      } catch (innerE) {
        syzoj.log('[hit-engine] Fallback save failed for history user ' + hist.user_id + ': ' + innerE.message);
      }
    }
  }
}

// ============ 清理过期历史记录(独立任务) ============
async function cleanOldHistory() {
  try {
    let now = parseInt((new Date()).getTime() / 1000);
    let cutoff = now - HISTORY_RETENTION_DAYS * 86400;
    let result = await UserHitScoreHistory.createQueryBuilder()
      .delete()
      .where('recorded_at < :cutoff', { cutoff: cutoff })
      .execute();
    syzoj.log('[hit-engine] Cleaned ' + (result.affected || 0) + ' old history records');
  } catch (e) {
    syzoj.log('[hit-engine] Failed to clean old history: ' + e.message);
  }
}

// ============ 全量计算(优化版:批量查询+批量写入+互斥锁) ============
async function fullRecalc() {
  // 互斥锁检查
  if (_isRecalculating) {
    syzoj.log('[hit-engine] Recalc already running, skip.');
    return;
  }
  _isRecalculating = true;

  let started = Date.now();
  syzoj.log('[hit-engine] Full recalc started');

  try {
    // ========== 1. 批量预查询所有需要的数据 ==========
    syzoj.log('[hit-engine] Preloading batch data...');
    const batchData = await preloadBatchData();

    // ========== 2. 加载所有用户 ==========
    let users;
    try {
      users = await User.find({});
    } catch (e) {
      syzoj.log('[hit-engine] Failed to load users: ' + e.message);
      return;
    }

    let now = parseInt((new Date()).getTime() / 1000);
    let updated = 0;
    let failed = 0;

    // 收集所有 scores 用于批量写入
    let allScores = [];
    let allHistories = [];

    for (let u of users) {
      try {
        let scores = await calcOneUser(u, batchData);
        allScores.push(scores);

        // 准备历史记录数据
        allHistories.push({
          user_id: u.id,
          total: scores.total,
          basic_score: scores.basic_score,
          contribution_score: scores.contribution_score,
          contest_score: scores.contest_score,
          practice_score: scores.practice_score,
          recorded_at: now
        });

        updated++;
      } catch (e) {
        failed++;
        syzoj.log('[hit-engine] Failed for user ' + u.id + ': ' + e.message);
      }
    }

    // ========== 3. 批量写入数据库 ==========
    syzoj.log('[hit-engine] Bulk writing to database...');
    await bulkWriteScores(allScores, now);
    await bulkWriteHistories(allHistories);

    // ========== 4. 立刻刷新内存缓存 ==========
    await refreshMemoryCache();

    let elapsed = ((Date.now() - started) / 1000).toFixed(1);
    syzoj.log('[hit-engine] Full recalc done: ' + updated + ' ok, ' + failed + ' failed, ' + elapsed + 's');

  } finally {
    _isRecalculating = false;
  }
}

// ============ 刷新内存缓存 ============
async function refreshMemoryCache() {
  try {
    let rows = await UserHitScore.find({});
    let m = new Map();
    for (let r of rows) {
      m.set(r.user_id, {
        total: r.total,
        basic_score: r.basic_score,
        contribution_score: r.contribution_score,
        contest_score: r.contest_score,
        practice_score: r.practice_score
      });
    }
    syzoj.userHitScores = m;
  } catch (e) {
    syzoj.log('[hit-engine] Refresh memory cache failed: ' + e.message);
  }
}

// 暴露给外部:手动触发
syzoj.recalcHitScores = fullRecalc;

// 暴露互斥锁状态查询接口
syzoj.isRecalculatingHitScores = function() {
  return _isRecalculating;
};

// 启动延迟初始化(让数据库准备好)
setTimeout(async () => {
  try {
    await refreshMemoryCache();
    syzoj.log('[hit-engine] Memory cache loaded: ' + syzoj.userHitScores.size + ' users');

    // 如果缓存表是空的,立刻做一次全量计算
    if (syzoj.userHitScores.size === 0) {
      syzoj.log('[hit-engine] Cache table empty, doing initial calculation...');
      await fullRecalc();
    }

    // 周期任务
    setInterval(refreshMemoryCache, CACHE_REFRESH_INTERVAL_MS);
    setInterval(fullRecalc, FULL_RECALC_INTERVAL_MS);

    // 独立的历史清理任务(与 fullRecalc 解耦)
    setInterval(cleanOldHistory, CLEANUP_INTERVAL_MS);
    // 启动时立即执行一次清理
    cleanOldHistory();

  } catch (e) {
    syzoj.log('[hit-engine] Init failed: ' + e.message);
  }
}, INITIAL_DELAY_MS);
// ============ 管理员手动触发重算 ============
app.post('/admin/recalc-hit-scores', async (req, res) => {
  try {
    if (!res.locals.user || !res.locals.user.is_admin) {
      throw new ErrorMessage('您没有权限进行此操作。');
    }

    // 检查是否已在运行
    if (_isRecalculating) {
      return res.render('success', {
        title: 'Hit 值重算',
        message: 'Hit 值重算已在进行中',
        details: '当前已有重算任务正在执行，请稍后再试。',
        nextUrls: {
          '返回首页': '/',
          '返回后台': '/admin/info'
        }
      });
    }

    // 异步触发,不等结果
    fullRecalc().catch(function(e) {
      syzoj.log('[hit-engine] Manual recalc failed: ' + e.message);
    });

    res.render('success', {
      title: 'Hit 值重算',
      message: 'Hit 值重算已开始',
      details: '这是后台异步任务，大约需要 10-30 秒完成。完成后内存缓存将自动刷新，可在用户主页查看新分数。',
      nextUrls: {
        '返回首页': '/',
        '返回后台': '/admin/info'
      }
    });
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 工具:获取或创建 Hit 设置记录 ============
async function getOrCreateHitSetting(userId) {
  let s = await UserHitSetting.findOne({ where: { user_id: userId } });
  if (!s) {
    s = await UserHitSetting.create();
    s.user_id = userId;
    s.hide_hit = false;
  }
  return s;
}

// 暴露给模板用:同步检查某用户是否选择了隐藏 Hit 卡片
// 用全局缓存(每分钟刷新一次同 hit score 缓存)
syzoj.userHitHidden = new Set();

async function refreshHitHiddenSet() {
  try {
    let rows = await UserHitSetting.createQueryBuilder()
      .where('hide_hit = TRUE')
      .getMany();
    let s = new Set();
    for (let r of rows) s.add(r.user_id);
    syzoj.userHitHidden = s;
  } catch (e) {
    syzoj.log('[hit-engine] Refresh hidden set failed: ' + e.message);
  }
}
// 启动时延后刷新(等数据库准备好)
setTimeout(refreshHitHiddenSet, 30 * 1000);
setInterval(refreshHitHiddenSet, 60 * 1000);

// ============ 用户保存 Hit 隐藏设置 ============
app.post('/user/:id/hit-setting', async (req, res) => {
  try {
    if (!res.locals.user) throw new ErrorMessage('请登录后继续。');
    let uid = parseInt(req.params.id);
    if (uid !== res.locals.user.id && !res.locals.user.is_admin) {
      throw new ErrorMessage('您没有权限修改他人的设置。');
    }

    let s = await getOrCreateHitSetting(uid);
    s.hide_hit = (req.body.hide_hit === 'on' || req.body.hide_hit === 'true' || req.body.hide_hit === '1');
    s.update_time = parseInt((new Date()).getTime() / 1000);
    await s.save();

    // 立刻刷新内存缓存
    if (s.hide_hit) syzoj.userHitHidden.add(uid);
    else syzoj.userHitHidden.delete(uid);

    res.redirect(syzoj.utils.makeUrl(['user', uid, 'edit']));
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ Hit 值帮助页 ============
app.get('/help/hit-value', async (req, res) => {
  try {
    res.render('help_hit_value');
  } catch (e) {
    syzoj.log(e);
    res.render('error', { err: e });
  }
});

// ============ 历史趋势 API:返回某用户过去 N 天的 Hit 历史 ============
app.get('/api/hit-history/:uid', async (req, res) => {
  try {
    let uid = parseInt(req.params.uid);
    if (!uid) {
      return res.json({ ok: false, message: 'invalid uid' });
    }

    // 检查目标用户是否隐藏了 Hit 卡片
    if (syzoj.userHitHidden && syzoj.userHitHidden.has(uid)) {
      // 隐藏开关开启时,只允许本人看
      if (!res.locals.user || res.locals.user.id !== uid) {
        return res.json({ ok: false, message: 'hidden by user' });
      }
    }

    let days = parseInt(req.query.days) || 30;
    if (days < 1 || days > 90) days = 30;

    let now = parseInt((new Date()).getTime() / 1000);
    let cutoff = now - days * 86400;

    let rows = await UserHitScoreHistory.createQueryBuilder()
      .where('user_id = :uid', { uid: uid })
      .andWhere('recorded_at >= :cutoff', { cutoff: cutoff })
      .orderBy('recorded_at', 'ASC')
      .getMany();

    // 序列化成前端友好的格式
    let points = rows.map(function(r) {
      return {
        t: r.recorded_at,
        basic: r.basic_score,
        contribution: r.contribution_score,
        contest: r.contest_score,
        practice: r.practice_score
      };
    });

    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, points: points, days: days });
  } catch (e) {
    syzoj.log(e);
    res.json({ ok: false, message: e.message });
  }
});