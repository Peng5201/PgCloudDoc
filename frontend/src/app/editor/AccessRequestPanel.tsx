/**
 * 权限申请页 —— 无权限打开文档时显示。
 * 点击申请后创建申请，等待创建者在消息中心审批。
 */

import { useState } from 'react';
import { App, Button, Result } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { ApiError } from '../api/client';
import { documentsApi } from '../api/documents';

export function AccessRequestPanel({ documentId }: { documentId: string }) {
    const { message: messageApi } = App.useApp();
    const [requested, setRequested] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    async function handleRequest() {
        setSubmitting(true);
        try {
            await documentsApi.requestAccess(documentId);
            setRequested(true);
            messageApi.success('申请已提交，等待创建者审批');
        } catch (err) {
            messageApi.error(
                err instanceof ApiError ? err.message : '申请失败，请稍后再试'
            );
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <Result
            icon={<LockOutlined style={{ color: '#ff8800' }} />}
            title="无权访问此文档"
            subTitle="你需要向创建者申请访问权限"
            extra={
                requested ? (
                    <Button type="primary" disabled>
                        已提交申请，等待审批
                    </Button>
                ) : (
                    <Button type="primary" loading={submitting} onClick={handleRequest}>
                        申请访问
                    </Button>
                )
            }
        />
    );
}
