export function logChanges(
  lang: string,
  changes: { added: string[]; updated: string[]; removed: string[] }
) {
  console.log(`\n[${lang}] 翻译更新情况:`);

  if (changes.added.length > 0) {
    console.log(`🆕 新增 ${changes.added.length} 项:`);
    changes.added.forEach((k) => console.log(`+ ${k}`));
  }

  if (changes.updated.length > 0) {
    console.log(`✏️ 更新 ${changes.updated.length} 项:`);
    changes.updated.forEach((k) => console.log(`~ ${k}`));
  }

  if (changes.removed.length > 0) {
    console.log(`❌ 移除 ${changes.removed.length} 项:`);
    changes.removed.forEach((k) => console.log(`- ${k}`));
  }

  if (
    changes.added.length === 0 &&
    changes.updated.length === 0 &&
    changes.removed.length === 0
  ) {
    console.log(`✅ 无需更新`);
  }
}
