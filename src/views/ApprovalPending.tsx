// 文件簽核 — 待簽核
import ApprovalList from './ApprovalList.tsx';

export default function ApprovalPending() {
  return <ApprovalList mode="pending" title="待簽核" />;
}
ApprovalPending.title = '待簽核';
