/**
 * 协作者面板（文档右上角）。
 *
 * 展示成员邮箱列表；owner 可以对成员改角色/移除，对访问申请同意（选角色）/拒绝。
 */

import { useCallback, useEffect, useState } from 'react';
import {
    App,
    Avatar,
    Button,
    Divider,
    Dropdown,
    Empty,
    List,
    Popconfirm,
    Space,
    Tag,
    Tooltip,
    Typography,
} from 'antd';
import {
    CheckOutlined,
    CloseOutlined,
    TeamOutlined,
    UserOutlined,
} from '@ant-design/icons';
import { documentsApi, type AccessRequest, type Member } from '../api/documents';
import { useAuth } from '../auth/AuthContext';
import { collabColor } from '../collab/doc-sync';

const { Text } = Typography;

type Role = 'OWNER' | 'EDITOR' | 'VIEWER';

interface CollaboratorsPopoverProps {
    documentId: string;
    /** 当前用户角色，决定能否管理 */
    myRole: Role | null;
    /** 成员/申请变化后回调（让外层刷新自己的角色） */
    onChanged?: () => void;
}

/** 顶栏最多摆几个头像 */
const MAX_AVATARS = 4;

export function CollaboratorsPopover({
    documentId,
    myRole,
    onChanged,
}: CollaboratorsPopoverProps) {
    const { message: messageApi } = App.useApp();
    const { user } = useAuth();
    const [open, setOpen] = useState(false);
    const [members, setMembers] = useState<Member[]>([]);
    const [requests, setRequests] = useState<AccessRequest[]>([]);

    const isOwner = myRole === 'OWNER';

    const load = useCallback(async () => {
        try {
            const m = await documentsApi.members(documentId);
            setMembers(m);
            if (isOwner) {
                const r = await documentsApi.accessRequests(documentId);
                setRequests(r.filter((x) => x.status === 'PENDING'));
            }
        } catch {
            // 拉不到就保持现状
        }
    }, [documentId, isOwner]);

    // 挂载就拉一次：顶栏要显示人数和在线头像，不能等点开才拉
    useEffect(() => {
        void load();
    }, [load]);

    // 展开时再刷一次，保证面板里的成员/申请是最新的
    useEffect(() => {
        if (open) void load();
    }, [open, load]);

    // 消息中心点击权限相关消息时，触发展开本面板
    useEffect(() => {
        const handler = () => setOpen(true);
        window.addEventListener('pgclouddoc:open-collaborators', handler);
        return () => window.removeEventListener('pgclouddoc:open-collaborators', handler);
    }, []);

    async function changeRole(target: Member, role: 'EDITOR' | 'VIEWER') {
        await documentsApi.updateMemberRole(documentId, target.userId, role);
        messageApi.success(`已把 ${target.displayName ?? target.email} 设为${role === 'EDITOR' ? '编辑' : '只读'}`);
        await load();
        onChanged?.();
    }

    async function remove(target: Member) {
        await documentsApi.removeMember(documentId, target.userId);
        messageApi.success(`已移除 ${target.displayName ?? target.email}`);
        await load();
        onChanged?.();
    }

    async function approve(request: AccessRequest, role: 'EDITOR' | 'VIEWER') {
        await documentsApi.approveAccessRequest(documentId, request.id, role);
        messageApi.success('已通过申请');
        await load();
        onChanged?.();
    }

    async function reject(request: AccessRequest) {
        await documentsApi.rejectAccessRequest(documentId, request.id);
        messageApi.success('已拒绝申请');
        await load();
    }

    // 有操作按钮（改角色/移除/审批）时才需要宽一点；纯展示就收紧
    const hasActions =
        isOwner && (members.some((m) => m.role !== 'OWNER') || requests.length > 0);

    const content = (
        <div style={{ ...styles.panel, width: hasActions ? 360 : 260 }}>
            <Text strong>协作者（{members.length}）</Text>
            <List
                size="small"
                dataSource={members}
                renderItem={(m) => (
                    <List.Item
                        actions={
                            isOwner && m.role !== 'OWNER'
                                ? [
                                      <Dropdown
                                          key="role"
                                          menu={{
                                              items: [
                                                  {
                                                      key: 'EDITOR',
                                                      label: '设为编辑',
                                                      disabled: m.role === 'EDITOR',
                                                  },
                                                  {
                                                      key: 'VIEWER',
                                                      label: '设为只读',
                                                      disabled: m.role === 'VIEWER',
                                                  },
                                              ],
                                              onClick: ({ key }) =>
                                                  void changeRole(m, key as 'EDITOR' | 'VIEWER'),
                                          }}
                                      >
                                          <Button size="small" type="link">
                                              {m.role === 'EDITOR' ? '编辑' : '只读'}
                                          </Button>
                                      </Dropdown>,
                                      <Popconfirm
                                          key="remove"
                                          title={`移除 ${m.displayName ?? m.email}？`}
                                          onConfirm={() => void remove(m)}
                                          okText="移除"
                                          cancelText="取消"
                                      >
                                          <Button size="small" type="link" danger>
                                              移除
                                          </Button>
                                      </Popconfirm>,
                                  ]
                                : undefined
                        }
                    >
                        <List.Item.Meta
                            avatar={
                                <Avatar size="small">
                                    {(m.displayName ?? m.email ?? '?').slice(0, 1)}
                                </Avatar>
                            }
                            title={
                                <Space size={6} style={{ whiteSpace: 'nowrap' }}>
                                    <Text ellipsis>{m.displayName ?? m.username}</Text>
                                    {m.userId === user?.id && <Tag color="red">我</Tag>}
                                    <Tag color={roleColor(m.role)}>{roleLabel(m.role)}</Tag>
                                </Space>
                            }
                            description={
                                <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                                    {m.email}
                                </Text>
                            }
                        />
                    </List.Item>
                )}
            />

            {isOwner && requests.length > 0 && (
                <>
                    <Divider style={{ margin: '8px 0' }} />
                    <Text strong>待处理申请（{requests.length}）</Text>
                    <List
                        size="small"
                        dataSource={requests}
                        renderItem={(r) => (
                            <List.Item
                                actions={[
                                    <Dropdown
                                        key="approve"
                                        menu={{
                                            items: [
                                                { key: 'EDITOR', label: '同意为编辑' },
                                                { key: 'VIEWER', label: '同意为只读' },
                                            ],
                                            onClick: ({ key }) =>
                                                void approve(r, key as 'EDITOR' | 'VIEWER'),
                                        }}
                                    >
                                        <Button size="small" type="link" icon={<CheckOutlined />}>
                                            同意
                                        </Button>
                                    </Dropdown>,
                                    <Button
                                        key="reject"
                                        size="small"
                                        type="link"
                                        danger
                                        icon={<CloseOutlined />}
                                        onClick={() => void reject(r)}
                                    >
                                        拒绝
                                    </Button>,
                                ]}
                            >
                                <List.Item.Meta
                                    avatar={<Avatar size="small" icon={<UserOutlined />} />}
                                    title={
                                        <Text ellipsis>
                                            {r.requesterDisplayName ?? r.requesterUsername}
                                        </Text>
                                    }
                                    description={
                                        <Text
                                            type="secondary"
                                            style={{ fontSize: 12 }}
                                            ellipsis
                                        >
                                            {r.requesterEmail}
                                        </Text>
                                    }
                                />
                            </List.Item>
                        )}
                    />
                </>
            )}

            {isOwner && requests.length === 0 && members.length > 0 && (
                <>
                    <Divider style={{ margin: '8px 0' }} />
                    <Empty description="暂无待处理申请" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                </>
            )}
        </div>
    );

    // 头像按**协作者列表**构建（不是在线 peers）：列表才是"谁有权访问"，
    // 头像按成员列表构建：列表才是"谁有权访问"
    const shownMembers = members.slice(0, MAX_AVATARS);

    return (
        <Tooltip title="查看协作者">
            <Dropdown
                open={open}
                onOpenChange={setOpen}
                trigger={['click']}
                dropdownRender={() => content}
            >
                <Button type="text" style={styles.trigger}>
                    <span style={styles.triggerInner}>
                        {shownMembers.length > 0 ? (
                            <span style={styles.avatarRow}>
                                {shownMembers.map((member, index) => (
                                    <Avatar
                                        key={member.userId}
                                        size={24}
                                        style={{
                                            position: 'relative',
                                            background: collabColor(member.userId),
                                            marginLeft: index === 0 ? 0 : -9,
                                            border: '2px solid #1f2329',
                                            fontSize: 11,
                                            // 左边的完整显示，右边的压在最底层：
                                            // 序号越小 z 越高
                                            zIndex: shownMembers.length - index,
                                        }}
                                    >
                                        {(member.displayName ?? member.username).slice(0, 1)}
                                    </Avatar>
                                ))}
                            </span>
                        ) : (
                            <TeamOutlined style={{ color: 'rgba(255,255,255,0.75)' }} />
                        )}
                        <span style={styles.count}>
                            {members.length > 0 ? `${members.length} 人` : '协作者'}
                        </span>
                    </span>
                </Button>
            </Dropdown>
        </Tooltip>
    );
}

function roleLabel(role: Role): string {
    return role === 'OWNER' ? '创建者' : role === 'EDITOR' ? '编辑' : '只读';
}

function roleColor(role: Role): string {
    return role === 'OWNER' ? 'gold' : role === 'EDITOR' ? 'blue' : 'default';
}

const styles = {
    trigger: {
        height: 32,
        // 与顶栏图标按钮一致：左右各 8px，图标按钮的 32×32 里也是 8px 侧边距
        paddingInline: 8,
    },
    triggerInner: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        color: '#fff',
    },
    avatarRow: {
        display: 'inline-flex',
        alignItems: 'center',
        // 留出 hover 上浮的空间，别被按钮裁掉
        paddingBlock: 4,
        paddingInline: 2,
    },
    count: {
        fontSize: 12,
        lineHeight: 1,
        color: 'rgba(255,255,255,0.85)',
        whiteSpace: 'nowrap' as const,
    },
    panel: {
        padding: 10,
        background: '#fff',
        borderRadius: 8,
        boxShadow: '0 6px 16px rgba(0,0,0,0.12)',
    },
};
