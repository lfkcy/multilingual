/**
 * 拍平json
 * @param obj 需要拍平的json对象
 * @param prefix 前缀
 * @param result 结果
 * @returns 拍平后的json对象
 */
function flatten(obj: any, prefix = "", result: Record<string, any> = {}) {
  for (const key in obj) {
    const value = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // 检查是否为 step 对象
      if (key === "step") {
        // 重新映射索引从0开始
        Object.keys(value).forEach((stepKey, index) => {
          result[`${prefix}.${key}.${index}`] = value[stepKey];
        });
      } else {
        flatten(value, newKey, result);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "object" && item !== null) {
          flatten(item, `${newKey}.${index}`, result);
        } else {
          result[`${newKey}.${index}`] = item;
        }
      });
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

/**
 * 展开json
 * @param flatObj
 * @returns
 */
function unflattenJSON(flatObj: Record<string, any>) {
  const result: Record<string, any> = {};
  for (const key in flatObj) {
    const parts = key.split(".");
    let current = result;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];
      const isArrayIndex = /^\d+$/.test(nextPart);

      if (i === parts.length - 1) {
        current[part] = flatObj[key];
      } else {
        if (!(part in current)) {
          current[part] = isArrayIndex ? [] : {};
        }
        current = current[part];
      }
    }
  }
  return result;
}

export { flatten, unflattenJSON };
