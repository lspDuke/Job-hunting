/**
 * 智能招聘搜索核心逻辑
 * 在 OpenClaw agent 环境中调用 web_search 工具
 */

/**
 * 搜索招聘信息
 * @param {Object} options 搜索选项
 * @param {string} options.location 工作地点
 * @param {string} options.keywords 搜索关键词
 * @param {number} [options.minSalary] 最低薪资
 * @param {string[]} [options.excludeKeywords] 排除关键词
 * @param {number} [options.count=10] 返回结果数量
 * @returns {Promise<Array>} 整理后的职位列表
 */
async function searchJobs(options) {
  const {
    location,
    keywords,
    minSalary = 0,
    excludeKeywords = [],
    count = 10,
  } = options;

  // 构建搜索查询
  let query = `${location} ${keywords} 招聘 BOSS直聘 智联招聘`;
  if (minSalary > 0) {
    query += ` 薪资 ${Math.floor(minSalary / 1000)}K以上`;
  }

  // 调用 web_search 工具
  const searchResponse = await toolCall('web_search', {
    query: query,
    count: Math.min(count * 2, 10),
    country: 'CN',
    language: 'zh',
  });

  if (!searchResponse || !searchResponse.results || searchResponse.results.length === 0) {
    return [];
  }

  // 提取并筛选职位信息
  let jobs = searchResponse.results
    .map(result => extractJobInfo(result, minSalary, excludeKeywords))
    .filter(job => job !== null)
    .slice(0, count);

  // 补充注册资金信息
  for (const job of jobs) {
    if (job.companyName !== '未知公司') {
      job.registeredCapital = await fetchCompanyCapital(job.companyName, location);
    }
    job.recommendation = generateRecommendation(job, keywords);
  }

  return jobs;
}

/**
 * 从搜索结果提取职位信息
 */
function extractJobInfo(result, minSalary, excludeKeywords) {
  const content = result.content || '';
  const title = result.title || '';

  // 提取公司名称
  const companyName = extractCompanyName(title, content);

  // 检查排除关键词
  const text = `${title} ${content}`.toLowerCase();
  const isExcluded = excludeKeywords.some(keyword =>
    text.includes(keyword.toLowerCase())
  );

  if (isExcluded) {
    return null;
  }

  // 检查薪资
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
    location: null, // 由外层填入
    registeredCapital: '未知',
    description: content.substring(0, 300).replace(/\n/g, ' ').trim(),
    url: result.url,
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
 * 获取公司注册资金
 */
async function fetchCompanyCapital(companyName, location) {
  try {
    const query = `${companyName} ${location} 注册资金 工商信息 企查查`;
    const response = await toolCall('web_search', {
      query: query,
      count: 3,
      country: 'CN',
      language: 'zh',
    });

    if (response && response.results && response.results.length > 0) {
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
    console.warn(`获取 ${companyName} 注册资金失败:`, error);
    return '未知';
  }
}

/**
 * 生成推荐理由
 */
function generateRecommendation(job, keywords) {
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

  if (keywords.toLowerCase().includes('ai')) {
    reasons.push('布局人工智能领域，技术栈前沿');
  }

  if (reasons.length === 0) {
    return '招聘信息公开可查，岗位匹配度高';
  }

  return reasons.join('，');
}

/**
 * 生成 Markdown 表格
 */
function generateMarkdownTable(jobs, location, keywords) {
  let output = `# ${location} 地区 [${keywords}] 最新招聘信息\n\n`;
  output += `> 搜索时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
  output += '| 公司名称 | 所在地 | 注册资金 | 公司推荐理由 |\n';
  output += '|----------|--------|----------|--------------|\n';

  for (const job of jobs) {
    const companyName = (job.companyName || '未知公司').replace(/\|/g, '&#124;');
    const jobLocation = location.replace(/\|/g, '&#124;');
    const capital = (job.registeredCapital || '未知').replace(/\|/g, '&#124;');
    const recommendation = job.recommendation.replace(/\|/g, '&#124;');
    output += `| ${companyName} | ${jobLocation} | ${capital} | ${recommendation} |\n`;
  }

  output += `\n*数据来源: OpenClaw web_search 聚合各大招聘平台公开信息*\n`;
  return output;
}

// 导出
export default {
  searchJobs,
  generateMarkdownTable,
};
