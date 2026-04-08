#!/usr/bin/env node
/**
 * 智能招聘搜索脚本
 * 使用 Brave Search API（通过 OpenClaw 配置）搜索招聘信息并整理成表格
 * 无需用户提供 API Key，使用 OpenClaw 已配置的搜索能力
 */

import { parseArgs } from 'node:util';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

// 获取当前脚本目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Node.js 环境下需要引入 node-fetch
import { execSync } from 'node:child_process';
let fetch;
try {
  fetch = (await import('node-fetch')).default;
} catch (e) {
  // 如果没安装，尝试安装
  console.log('Installing node-fetch...');
  execSync('npm install node-fetch --prefix ' + __dirname + '/..', { stdio: 'inherit' });
  fetch = (await import('node-fetch')).default;
}

// Brave Search API 端点
const BRAVE_SEARCH_API = 'https://api.search.brave.com/res/v1/web/search';

/**
 * 调用 Brave Search API
 */
async function braveSearch(query, count = 10) {
  // 尝试从环境变量获取 API Key
  let apiKey = process.env.BRAVE_API_KEY;

  // 如果没有，尝试从搜索配置获取（OpenClaw 内置）
  if (!apiKey && process.env.OPENCLAW_BRAVE_API_KEY) {
    apiKey = process.env.OPENCLAW_BRAVE_API_KEY;
  }

  if (!apiKey) {
    apiKey = await promptForKey('BRAVE_API_KEY');
    if (!apiKey) {
      console.error('错误: 未提供 BRAVE_API_KEY，无法继续执行');
      process.exit(1);
    }
  }

  const url = new URL(BRAVE_SEARCH_API);
  url.searchParams.set('q', query);
  url.searchParams.set('count', Math.min(count, 20));
  url.searchParams.set('country', 'CN');
  url.searchParams.set('lang', 'zh');

  const headers = {
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip',
    'X-Subscription-Token': apiKey,
  };

  const response = await fetch(url, {
    method: 'GET',
    headers: headers,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Brave Search failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    results: (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      content: r.description,
    })),
  };
}

async function promptForKey(keyName) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const question = (text) =>
    new Promise((resolve) => rl.question(text, resolve));

  try {
    const value = (await question(`未检测到 ${keyName}，请输入后回车（仅用于本次运行，不会写入文件）：`)).trim();
    return value;
  } finally {
    rl.close();
  }
}

// 解析命令行参数
const { values } = parseArgs({
  options: {
    location: {
      type: 'string',
    },
    keywords: {
      type: 'string',
    },
    'min-salary': {
      type: 'string',
    },
    exclude: {
      type: 'string',
    },
    count: {
      type: 'string',
      default: '10',
    },
    output: {
      type: 'string',
    },
  },
});

if (!values.location || !values.keywords) {
  console.error('错误: --location 和 --keywords 为必填参数');
  console.error('示例: node search.mjs --location "重庆" --keywords "AI 智能体 AI Agent" --min-salary 6000 --exclude "标注员 数据标注"');
  process.exit(1);
}

const location = values.location;
const keywords = values.keywords;
const minSalary = values['min-salary'] ? parseInt(values['min-salary'], 10) : 0;
const excludeKeywords = values.exclude ? values.exclude.split(/\s+/) : [];
const resultCount = parseInt(values.count, 10);
const outputFile = values.output;

/**
 * 构建搜索查询
 */
function buildSearchQuery() {
  let query = `${location} ${keywords} 招聘 BOSS直聘 智联招聘`;
  if (minSalary > 0) {
    query += ` 薪资 ${Math.floor(minSalary / 1000)}K以上`;
  }
  return query;
}

/**
 * 从搜索结果中提取职位信息
 */
function extractJobInfo(result) {
  const content = result.content || '';
  const url = result.url;
  const title = result.title || '';

  // 尝试提取公司名称
  let companyName = extractCompanyName(title, content);

  // 检查是否包含排除关键词
  const text = `${title} ${content}`.toLowerCase();
  const isExcluded = excludeKeywords.some(keyword =>
    text.includes(keyword.toLowerCase())
  );

  if (isExcluded) {
    return null;
  }

  // 提取薪资信息并检查
  if (minSalary > 0) {
    const salaryMatch = text.match(/(\d+)[kK]-\d+[kK]|(\d+)[kK]\/月|月薪\s*(\d+)/);
    if (salaryMatch) {
      const salary = parseInt(salaryMatch[1] || salaryMatch[2] || salaryMatch[3], 10) * 1000;
      if (salary < minSalary) {
        return null; // 低于最低薪资要求，过滤掉
      }
    }
  }

  return {
    companyName: companyName || '未知公司',
    location: location,
    registeredCapital: '未知', // 需要进一步搜索
    description: content.substring(0, 300).replace(/\n/g, ' ').trim(),
    url: url,
  };
}

/**
 * 从文本中提取公司名称
 */
function extractCompanyName(title, content) {
  // 常见模式：XX公司、XX科技、XX集团
  const patterns = [
    /([\u4e00-\u9fa5a-zA-Z0-9]+(?:公司|集团|科技|网络|信息技术|企业|有限公司|股份公司|合伙企业))/,
    /^([\u4e00-\u9fa5a-zA-Z0-9]+)\s*[-|招聘]/,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern) || content.match(pattern);
    if (match && match[1].length > 1 && match[1].length < 30) {
      return match[1];
    }
  }

  // 如果没找到，尝试从标题中提取第一部分
  const parts = title.split(/[-\s|_]/);
  if (parts[0] && parts[0].length > 1 && parts[0].length < 20) {
    return parts[0];
  }

  return null;
}

/**
 * 搜索公司注册资金信息
 */
async function fetchCompanyRegisteredCapital(companyName) {
  try {
    const query = `${companyName} ${location} 注册资金 工商信息 企查查`;
    const response = await braveSearch(query, 3);

    if (response.results && response.results.length > 0) {
      for (const result of response.results) {
        const content = result.content || '';
        const match = content.match(/注册资本[:：]\s*(\d+(?:\.\d+)?)(?:万|万元|亿)/i);
        if (match) {
          const amount = parseFloat(match[1]);
          const unit = match[0].includes('亿') ? '亿' : '万';
          return `${amount}${unit}`;
        }
      }
    }
    return '未知';
  } catch (error) {
    console.warn(`获取 ${companyName} 注册资金信息失败:`, error.message);
    return '未知';
  }
}

/**
 * 生成推荐理由
 */
function generateRecommendation(job) {
  const reasons = [];

  if (job.registeredCapital && job.registeredCapital !== '未知') {
    const amount = parseFloat(job.registeredCapital);
    if (amount >= 1000) {
      reasons.push('公司规模较大，资金实力雄厚');
    } else if (amount >= 100) {
      reasons.push('企业规模适中，发展潜力良好');
    } else {
      reasons.push('初创团队，成长空间大');
    }
  } else {
    reasons.push('工商信息暂未公开，建议面试时进一步了解');
  }

  // 根据职位关键词添加推荐理由
  if (keywords.toLowerCase().includes('ai')) {
    reasons.push('布局人工智能领域，技术栈前沿');
  }

  if (reasons.length === 0) {
    return '招聘信息公开可查，岗位匹配度高';
  }

  return reasons.join('，');
}

/**
 * 主函数
 */
async function main() {
  console.log(`🔍 开始搜索 ${location} 地区 [${keywords}] 相关职位...\n`);

  const query = buildSearchQuery();
  console.log(`搜索关键词: ${query}\n`);

  try {
    const response = await braveSearch(query, Math.min(resultCount * 2, 20));

    if (!response.results || response.results.length === 0) {
      console.log('未找到相关招聘信息');
      return;
    }

    console.log(`获取到 ${response.results.length} 条搜索结果，正在筛选...\n`);

    // 提取并筛选职位信息
    let jobs = response.results
      .map(extractJobInfo)
      .filter(job => job !== null)
      .slice(0, resultCount);

    if (jobs.length === 0) {
      console.log('筛选后无符合条件的招聘信息');
      return;
    }

    console.log(`筛选后剩余 ${jobs.length} 条符合条件的结果，正在补充公司信息...\n`);

    // 补充注册资金信息
    for (const job of jobs) {
      if (job.companyName !== '未知公司') {
        job.registeredCapital = await fetchCompanyRegisteredCapital(job.companyName);
      }
      job.recommendation = generateRecommendation(job);
    }

    // 生成 Markdown 表格
    let output = `# ${location} 地区 [${keywords}] 最新招聘信息\n\n`;
    output += `> 搜索时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
    output += '| 公司名称 | 所在地 | 注册资金 | 公司推荐理由 |\n';
    output += '|----------|--------|----------|--------------|\n';

    for (const job of jobs) {
      const companyName = (job.companyName || '未知公司').replace(/\|/g, '&#124;');
      const location = job.location.replace(/\|/g, '&#124;');
      const capital = (job.registeredCapital || '未知').replace(/\|/g, '&#124;');
      const recommendation = job.recommendation.replace(/\|/g, '&#124;');
      output += `| ${companyName} | ${location} | ${capital} | ${recommendation} |\n`;
    }

    output += `\n*数据来源: Brave Search 聚合各大招聘平台公开信息*\n`;

    // 输出结果
    console.log(output);

    // 如果指定了输出文件，写入文件
    if (outputFile) {
      fs.writeFileSync(outputFile, output, 'utf-8');
      console.log(`\n📝 结果已写入文件: ${outputFile}`);
    }

    return output;

  } catch (error) {
    console.error('搜索失败:', error.message);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('发生错误:', error);
  process.exit(1);
});
