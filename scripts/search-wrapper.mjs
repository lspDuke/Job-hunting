#!/usr/bin/env node
/**
 * 智能招聘搜索脚本
 * 使用已配置的 TAVILY_API_KEY（从环境变量继承）
 * 用户无需额外提供 API Key，只需要提供求职信息即可
 */

import { parseArgs } from 'node:util';
import process from 'node:process';
import fs from 'node:fs';
import fetch from 'node-fetch';
import readline from 'node:readline';

// TAVILY_API_KEY 从环境变量继承（OpenClaw 已配置）
let TAVILY_API_KEY = process.env.TAVILY_API_KEY;

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

if (!TAVILY_API_KEY) {
  TAVILY_API_KEY = await promptForKey('TAVILY_API_KEY');
  if (!TAVILY_API_KEY) {
    console.error('错误: 未提供 TAVILY_API_KEY，无法继续执行');
    process.exit(1);
  }
}

// 解析命令行参数
const { values } = parseArgs({
  options: {
    location: { type: 'string' },
    keywords: { type: 'string' },
    'min-salary': { type: 'string' },
    exclude: { type: 'string' },
    count: { type: 'string', default: '10' },
    output: { type: 'string' },
  },
});

if (!values.location || !values.keywords) {
  console.error('错误: --location 和 --keywords 为必填参数');
  console.error('示例: node search-wrapper.mjs --location "重庆" --keywords "AI 智能体 AI Agent" --min-salary 6000 --exclude "标注员 数据标注"');
  process.exit(1);
}

const config = {
  location: values.location,
  keywords: values.keywords,
  minSalary: values['min-salary'] ? parseInt(values['min-salary'], 10) : 0,
  excludeKeywords: values.exclude ? values.exclude.split(/\s+/) : [],
  count: parseInt(values.count, 10),
  outputFile: values.output,
};

/**
 * 调用 Tavily Search API
 */
async function tavilySearch(query, maxResults = 10, searchDepth = 'basic') {
  const body = {
    api_key: TAVILY_API_KEY,
    query: query,
    search_depth: searchDepth,
    topic: 'general',
    max_results: Math.max(1, Math.min(maxResults, 20)),
    include_answer: false,
    include_raw_content: false,
  };

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Tavily Search failed (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * 从搜索结果提取职位信息
 */
function extractJobInfo(result, minSalary, excludeKeywords) {
  const content = result.content || '';
  const title = result.title || '';

  const companyName = extractCompanyName(title, content);

  const text = `${title} ${content}`.toLowerCase();
  const isExcluded = excludeKeywords.some(keyword =>
    text.includes(keyword.toLowerCase())
  );

  if (isExcluded) {
    return null;
  }

  if (minSalary > 0) {
    const salaryMatch = text.match(/(\d+)[kK]-\d+[kK]|(\d+)[kK]\/月|月薪\s*(\d+)/);
    if (salaryMatch) {
      const salary = parseInt(salaryMatch[1] || salaryMatch[2] || salaryMatch[3], 10) * 1000;
      if (salary < minSalary) {
        return null;
      }
    }
  }

  return {
    companyName: companyName || '未知公司',
    location: config.location,
    registeredCapital: '未知',
    paidInCapital: '未知',
    companyEvaluation: '',
    jobMatchingScore: 0,
    jobUrl: result.url,
    sourceSite: extractSourceSite(result.url),
    description: content.substring(0, 300).replace(/\n/g, ' ').trim(),
  };
}

/**
 * 提取公司名称
 */
function extractCompanyName(title, content) {
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

  const parts = title.split(/[-\s|_]/);
  if (parts[0] && parts[0].length > 1 && parts[0].length < 20) {
    return parts[0];
  }

  return null;
}

/**
 * 根据URL提取招聘网站名称
 */
function extractSourceSite(url) {
  if (!url) return '未知';
  if (url.includes('zhipin.com') || url.includes('BOSS')) return 'BOSS直聘';
  if (url.includes('liepin.com')) return '猎聘';
  if (url.includes('zhaopin.com')) return '智联招聘';
  if (url.includes('51job.com')) return '前程无忧';
  if (url.includes('lagou.com')) return '拉勾网';
  if (url.includes('kanzhun.com')) return '看准网';
  if (url.includes('qiye.qianzhan.com')) return '前瞻产业研究院';
  if (url.includes('baidu.com')) return '百度搜索';
  return '其他';
}

/**
 * 获取公司注册资金和实缴资金信息
 */
async function fetchCompanyInfo(companyName, location) {
  try {
    const query = `${companyName} ${location} 注册资本 实缴资本 工商信息 企查查 公司评价`;
    const response = await tavilySearch(query, 4, 'basic');

    const result = {
      registeredCapital: '未知',
      paidInCapital: '未知',
      companyEvaluation: '',
    };

    if (response.results && response.results.length > 0) {
      let allContent = '';
      for (const r of response.results) {
        allContent += ' ' + (r.content || '');
      }

      // 提取注册资金
      const regMatch = allContent.match(/注册资本[:：]\s*(\d+(?:\.\d+)?)(?:万|万元|亿)/i);
      if (regMatch) {
        const amount = parseFloat(regMatch[1]);
        const unit = regMatch[0].includes('亿') ? '亿' : '万';
        result.registeredCapital = `${amount}${unit}`;
      }

      // 提取实缴资金
      const paidMatch = allContent.match(/实缴资本[:：]\s*(\d+(?:\.\d+)?)(?:万|万元|亿)/i);
      if (paidMatch) {
        const amount = parseFloat(paidMatch[1]);
        const unit = paidMatch[0].includes('亿') ? '亿' : '万';
        result.paidInCapital = `${amount}${unit}`;
      }

      // 提取公司评价/评分
      const ratingMatch = allContent.match(/评分[:：]\s*(\d(\.\d)?)/i);
      if (ratingMatch) {
        result.companyEvaluation = `评分 ${ratingMatch[1]}/5.0`;
      } else if (allContent.includes('好评') || allContent.includes('推荐')) {
        result.companyEvaluation = '员工评价整体较好';
      } else if (allContent.includes('差评') || allContent.includes('不推荐')) {
        result.companyEvaluation = '员工评价一般，需谨慎';
      }
    }

    if (!result.companyEvaluation) {
      result.companyEvaluation = '暂无公开评价';
    }

    return result;
  } catch (error) {
    console.warn(`获取 ${companyName} 工商信息失败:`, error.message);
    return {
      registeredCapital: '未知',
      paidInCapital: '未知',
      companyEvaluation: '暂无公开评价',
    };
  }
}

/**
 * 生成公司评价和计算岗位匹配度
 */
function generateJobEvaluation(job, keywords) {
  const reasons = [];
  let matchingScore = 0;

  // 根据公司规模评分
  if (job.registeredCapital && job.registeredCapital !== '未知') {
    const amount = parseFloat(job.registeredCapital);
    if (amount >= 1000) {
      reasons.push('公司规模较大，资金实力雄厚');
      matchingScore += 30;
    } else if (amount >= 100) {
      reasons.push('企业规模适中，发展潜力良好');
      matchingScore += 20;
    } else {
      reasons.push('初创团队，成长空间大');
      matchingScore += 10;
    }
  } else {
    reasons.push('工商信息暂未公开，建议面试时进一步了解');
  }

  // 根据关键词匹配评分
  const keywordList = keywords.toLowerCase().split(/\s+/);
  const matchedKeywords = keywordList.filter(k => 
    job.description.toLowerCase().includes(k)
  );
  if (matchedKeywords.length > 0) {
    matchingScore += matchedKeywords.length * 15;
    if (keywords.toLowerCase().includes('ai')) {
      reasons.push('布局人工智能领域，技术栈前沿');
    }
  }

  // 限制在 0-100 之间
  matchingScore = Math.min(Math.max(matchingScore, 10), 100);

  // 添加公司评价
  if (job.companyEvaluation && job.companyEvaluation !== '暂无公开评价') {
    reasons.push(job.companyEvaluation);
  }

  return {
    companyRecommendation: reasons.join('，'),
    matchingScore: Math.round(matchingScore),
  };
}

/**
 * 生成 Markdown 表格
 */
function generateMarkdownTable(jobs, location, keywords) {
  let output = `# ${location} 地区 [${keywords}] 最新招聘信息\n\n`;
  output += `> 搜索时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
  output += '| 公司名称 | 公司地址 | 注册资金 | 实缴资金 | 公司评价 | 匹配度 | 招聘网站 | 岗位链接 |\n';
  output += '|----------|----------|----------|----------|----------|--------|----------|----------|\n';

  for (const job of jobs) {
    const companyName = (job.companyName || '未知公司').replace(/\|/g, '&#124;');
    const jobLocation = (job.location || location).replace(/\|/g, '&#124;');
    const registeredCapital = (job.registeredCapital || '未知').replace(/\|/g, '&#124;');
    const paidInCapital = (job.paidInCapital || '未知').replace(/\|/g, '&#124;');
    const companyEval = (job.companyRecommendation || '暂无').replace(/\|/g, '&#124;');
    const matchingScore = `${job.jobMatchingScore || 0}分`;
    const sourceSite = (job.sourceSite || '未知').replace(/\|/g, '&#124;');
    const jobLink = job.jobUrl ? `[链接](${job.jobUrl})` : '无';
    
    output += `| ${companyName} | ${jobLocation} | ${registeredCapital} | ${paidInCapital} | ${companyEval} | ${matchingScore} | ${sourceSite} | ${jobLink} |\n`;
  }

  output += `\n*数据来源: Tavily Search 聚合各大招聘平台公开信息*\n`;
  output += `*匹配度: 满分 100 分，分数越高匹配度越好*\n`;
  return output;
}

/**
 * 主函数
 */
async function main() {
  console.log(`🔍 开始搜索 ${config.location} 地区 [${config.keywords}] 相关职位...\n`);

  let query = `${config.location} ${config.keywords} 招聘 BOSS直聘 智联招聘`;
  if (config.minSalary > 0) {
    query += ` 薪资 ${Math.floor(config.minSalary / 1000)}K以上`;
  }
  console.log(`搜索关键词: ${query}\n`);

  try {
    const response = await tavilySearch(query, Math.min(config.count * 2, 20), 'advanced');

    if (!response.results || response.results.length === 0) {
      console.log('未找到相关招聘信息');
      return;
    }

    console.log(`获取到 ${response.results.length} 条搜索结果，正在筛选...\n`);

    let jobs = response.results
      .map(result => extractJobInfo(result, config.minSalary, config.excludeKeywords))
      .filter(job => job !== null)
      .slice(0, config.count);

    if (jobs.length === 0) {
      console.log('筛选后无符合条件的招聘信息');
      return;
    }

    console.log(`筛选后剩余 ${jobs.length} 条符合条件的结果，正在补充公司信息...\n`);

    for (const job of jobs) {
      if (job.companyName !== '未知公司') {
        const companyInfo = await fetchCompanyInfo(job.companyName, config.location);
        job.registeredCapital = companyInfo.registeredCapital;
        job.paidInCapital = companyInfo.paidInCapital;
        job.companyEvaluation = companyInfo.companyEvaluation;
      }
      const evalResult = generateJobEvaluation(job, config.keywords);
      job.companyRecommendation = evalResult.companyRecommendation;
      job.jobMatchingScore = evalResult.matchingScore;
    }

    const markdown = generateMarkdownTable(jobs, config.location, config.keywords);
    console.log(markdown);

    if (config.outputFile) {
      fs.writeFileSync(config.outputFile, markdown, 'utf-8');
      console.log(`\n📝 结果已写入文件: ${config.outputFile}`);
    }

  } catch (error) {
    console.error('搜索失败:', error.message);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('发生错误:', error);
  process.exit(1);
});
