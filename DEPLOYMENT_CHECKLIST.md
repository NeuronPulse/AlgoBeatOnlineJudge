# Hit引擎优化部署检查清单

## 部署前检查

### 1. 代码验证
- [x] 语法检查通过 (`node --check`)
- [x] 所有6项优化已实施
- [x] 无重复函数定义
- [x] 文件编码为UTF-8

### 2. 数据库检查
```sql
-- 确认表存在且结构正确
SHOW TABLES LIKE 'user_hit_score%';
SHOW TABLES LIKE 'user_hit_score_history%';

-- 检查索引（确保批量查询性能）
SHOW INDEX FROM user_hit_score;
SHOW INDEX FROM user_hit_score_history;
```

### 3. 环境变量
- [ ] Node.js版本 >= 14.x
- [ ] 内存充足（建议至少2GB）
- [ ] 数据库连接池配置合理

## 部署步骤

### 步骤1: 备份
```bash
# 备份当前代码
cp /path/to/custom/modules/__hit_score_engine.js \
   /path/to/backups/__hit_score_engine.js.$(date +%Y%m%d_%H%M%S)

# 备份相关数据表
mysqldump -u root -p database_name user_hit_score user_hit_score_history > \
  hit_score_backup_$(date +%Y%m%d_%H%M%S).sql
```

### 步骤2: 部署新代码
```bash
# 复制新代码到目标位置
cp /workspace/custom/modules/__hit_score_engine.js \
   /path/to/custom/modules/__hit_score_engine.js

# 验证文件权限
chmod 644 /path/to/custom/modules/__hit_score_engine.js
```

### 步骤3: 重启应用
```bash
# 使用PM2管理
pm2 restart app_name

# 或使用systemd
sudo systemctl restart node-app

# 查看启动日志
pm2 logs app_name --lines 50
```

## 部署后验证

### 1. 应用启动检查
- [ ] 应用正常启动无报错
- [ ] 数据库连接成功
- [ ] 定时任务已注册

### 2. 功能测试
```javascript
// 在Node.js REPL中测试
syzoj.recalcHitScores().then(() => console.log('手动触发成功'));

// 检查互斥锁状态
syzoj.isRecalculatingHitScores(); // 应返回 true，重算完成后返回 false
```

### 3. 首次完整重算监控
```bash
# 查看首次fullRecalc日志
tail -f /path/to/logs/app.log | grep -E "(hit-engine|Recalc)"
```

监控指标：
n- [ ] 开始时间戳
- [ ] 批量数据加载耗时
- [ ] 用户计算耗时
- [ ] 批量写入耗时
- [ ] 总耗时
- [ ] 内存占用峰值

### 4. 性能对比（如有历史数据）
| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 数据库查询次数 | ~N×M | ~10 | -99% |
| 单用户计算耗时 | ~X ms | ~Y ms | -Z% |
| 全量重算总耗时 | ~A min | ~B min | -C% |
| 内存峰值 | ~M MB | ~N MB | -P% |

## 故障排查

### 问题1: 启动报错 "SyntaxError"
```bash
# 检查Node.js版本
node --version  # 需要 >= 14.x

# 检查文件编码
file /path/to/__hit_score_engine.js  # 应为UTF-8
```

### 问题2: 互斥锁未释放
```javascript
// 手动重置（仅在确认无重算运行时使用）
_isRecalculating = false;
```

### 问题3: 内存溢出
```bash
# 增加Node.js内存限制
node --max-old-space-size=4096 app.js
```

### 问题4: 批量写入失败
```sql
-- 检查表结构
DESCRIBE user_hit_score;
DESCRIBE user_hit_score_history;

-- 检查索引
SHOW INDEX FROM user_hit_score;
```

## 回滚方案

如需回滚到优化前版本：

```bash
# 停止应用
pm2 stop app_name

# 恢复备份代码
cp /path/to/backups/__hit_score_engine.js.backup_timestamp \
   /path/to/custom/modules/__hit_score_engine.js

# 重启应用
pm2 start app_name

# 验证回滚成功
tail -f /path/to/logs/app.log
```

## 联系支持

如遇紧急情况：
- 技术负责人: [填写]
- DBA: [填写]
- 运维: [填写]

---

**部署确认签字**: 

| 角色 | 姓名 | 日期 | 签字 |
|------|------|------|------|
| 开发 | | | |
| 测试 | | | |
| 运维 | | | |
