import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** true quando o usuário pediu para reduzir movimento nas configurações do sistema. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => { if (active) setReduce(value); })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => setReduce(value));
    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  return reduce;
}
