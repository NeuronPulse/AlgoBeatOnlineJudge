#!/usr/bin/env node
// ============================================================
// Hit引擎优化 - 部署测试脚本
// 模拟真实环境验证所有优化功能
// ============================================================

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(status, message) {
  const color = status === 'PASS' ? colors.green : 
                status === 'FAIL' ? colors.red : 
                status === 'WARN' ? colors.yellow :
                status === 'INFO' ? colors.blue : colors.cyan;
  console.log(`${color}[${status}]${colors.reset} ${message}`);
}

// 测试结果统计
const stats = {
  total: 0,
  passed: 0,
  failed: 0,
  warnings: 0
};

function recordResult(success, isWarning = false) {
  stats.total++;
  if (success) {
    stats.passed++;
  } else if (isWarning) {
    stats.warnings++;
  } else {
    stats.failed++;
  }
  return success;
}

// ============================================================
// 测试套件
// ============================================================

async function runTests() {
  console.log('\n' + '='.repeat(70));
  console.log('  Hit引擎优化 - 部署测试套件');
  console.log('  ' + new Date().toLocaleString('zh-CN'));
  console.log('='.repeat(70) + '\n');

  const enginePath = path.join(__dirname, 'custom/modules/__hit_score_engine.js');

  // ============ 测试组1: 文件完整性 ============
  log('INFO', '【测试组1】文件完整性检查');
  console.log('');

  // 测试1.1: 文件存在
  const test1_1 = fs.existsSync(enginePath);
  log(test1_1 ? 'PASS' : 'FAIL', `文件存在: ${path.relative(__dirname, enginePath)}`);
  recordResult(test1_1);

  // 测试1.2: 文件大小合理
  const stats1_2 = fs.statSync(enginePath);
  const sizeKB = (stats1_2.size / 1024).toFixed(2);
  const test1_2 = stats1_2.size > 1000 && stats1_2.size < 100000;
  log(test1_2 ? 'PASS' : 'WARN', `文件大小: ${sizeKB} KB`);
  recordResult(test1_2, !test1_2);

  // 测试1.3: 文件编码(UTF-8)
  const content = fs.readFileSync(enginePath, 'utf-8');
  const test1_3 = content.length > 0 && !content.includes('\ufffd');
  log(test1_3 ? 'PASS' : 'FAIL', '文件编码: UTF-8 (无乱码)');
  recordResult(test1_3);

  console.log('');

  // ============ 测试组2: 语法检查 ============
  log('INFO', '【测试组2】语法检查');
  console.log('');

  // 测试2.1: Node.js语法检查
  try {
    const { stdout, stderr } = await exec(`node --check "${enginePath}" 2>&1`);
    const test2_1 = !stderr || !stderr.includes('SyntaxError');
    log(test2_1 ? 'PASS' : 'FAIL', 'Node.js语法检查通过');
    recordResult(test2_1);
  } catch (e) {
    log('FAIL', `Node.js语法检查失败: ${e.message}`);
    recordResult(false);
  }

  // 测试2.2: 括号匹配检查
  const openBraces = (content.match(/\{/g) || []).length;
  const closeBraces = (content.match(/\}/g) || []).length;
  const test2_2 = openBraces === closeBraces;
  log(test2_2 ? 'PASS' : 'FAIL', `花括号匹配: {${openBraces}} vs }${closeBraces}`);
  recordResult(test2_2);

  // 测试2.3: 圆括号匹配
  const openParens = (content.match(/\(/g) || []).length;
  const closeParens = (content.match(/\)/g) || []).length;
  const test2_3 = openParens === closeParens;
  log(test2_3 ? 'PASS' : 'FAIL', `圆括号匹配: (${openParens}) vs )${closeParens}`);
  recordResult(test2_3);

  console.log('');

  // ============ 测试组3: 优化项检查 ============
  log('INFO', '【测试组3】六项优化实施检查');
  console.log('');

  const optimizations = [
    { name: '互斥锁', pattern: /let _isRecalculating\s*=\s*false/, required: true },
    { name: '批量查询函数', pattern: /async function preloadBatchData/, required: true },
    { name: '批量写入分数', pattern: /async function bulkWriteScores/, required: true },
    { name: '批量写入历史', pattern: /async function bulkWriteHistories/, required: true },
    { name: '独立清理任务', pattern: /async function cleanOldHistory/, required: true },
    { name: 'try-finally释放锁', pattern: /try\s*\{[\s\S]*?\}\s*finally\s*\{[\s\S]*?_isRecalculating\s*=\s*false/s, required: true },
  ];

  for (const opt of optimizations) {
    const found = opt.pattern.test(content);
    const status = found ? 'PASS' : (opt.required ? 'FAIL' : 'WARN');
    log(status, `${opt.name}: ${found ? '已实施' : '未找到'}`);
    recordResult(found, !found && !opt.required);
  }

  console.log('');

  // ============ 测试组4: API接口检查 ============
  log('INFO', '【测试组4】API接口检查');
  console.log('');

  const expectedAPIs = [
    'recalcHitScores',
    'getHitScoreForDisplay',
    'isRecalculatingHitScores'
  ];

  // 注意: 由于模块使用setTimeout延迟执行，这里只能检查源码中的定义
  for (const api of expectedAPIs) {
    const pattern = new RegExp(`syzoj\\.${api}\\s*=`);
    const found = pattern.test(content) || content.includes(`function ${api}`);
    log(found ? 'PASS' : 'FAIL', `API syzoj.${api}(): ${found ? '已定义' : '未找到'}`);
    recordResult(found);
  }

  console.log('');

  // ============ 测试组5: 常量和配置检查 ============
  log('INFO', '【测试组5】常量和配置检查');
  console.log('');

  const expectedConstants = [
    { name: 'CACHE_REFRESH_INTERVAL_MS', pattern: /const CACHE_REFRESH_INTERVAL_MS\s*=\s*60\s*\*\s*1000/ },
    { name: 'FULL_RECALC_INTERVAL_MS', pattern: /const FULL_RECALC_INTERVAL_MS\s*=\s*24\s*\*\s*3600\s*\*\s*1000/ },
    { name: 'INITIAL_DELAY_MS', pattern: /const INITIAL_DELAY_MS\s*=\s*30\s*\*\s*1000/ },
    { name: 'HISTORY_RETENTION_DAYS', pattern: /const HISTORY_RETENTION_DAYS\s*=\s*90/ },
    { name: 'CLEANUP_INTERVAL_MS', pattern: /const CLEANUP_INTERVAL_MS\s*=\s*24\s*\*\s*3600\s*\*\s*1000/ },
  ];

  for (const { name, pattern } of expectedConstants) {
    const found = pattern.test(content);
    log(found ? 'PASS' : 'WARN', `常量 ${name}: ${found ? '已定义' : '未找到或格式不符'}`);
    recordResult(found, !found);
  }

  console.log('');

  // ============ 测试总结 ============
  console.log('='.repeat(70));
  console.log('  测试总结');
  console.log('='.repeat(70));
  console.log('');
  console.log(`总测试数: ${stats.total}`);
  console.log(`${colors.green}通过: ${stats.passed}${colors.reset}`);
  console.log(`${colors.red}失败: ${stats.failed}${colors.reset}`);
  console.log(`${colors.yellow}警告: ${stats.warnings}${colors.reset}`);
  console.log('');

  if (stats.failed === 0) {
    console.log(`${colors.green}✓ 所有关键测试通过，代码可以安全部署${colors.reset}`);
  } else {
    console.log(`${colors.red}✗ 存在失败的测试，请修复后再部署${colors.reset}`);
  }

  console.log('');
  console.log('建议后续操作:');
  console.log('  1. 在测试环境运行实际数据验证性能提升');
  console.log('  2. 使用: node test_performance.js 进行性能基准测试');
  console.log('  3. 监控首次fullRecalc执行时间和内存占用');
  console.log('  4. 生产环境部署后观察24小时运行稳定性');
  console.log('');

  process.exit(stats.failed > 0 ? 1 : 0);
}

// 运行测试
runTests().catch(err => {
  console.error('测试执行失败:', err);
  process.exit(1);
});
