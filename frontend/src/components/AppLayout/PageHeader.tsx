import { SidebarTrigger } from '@/components/ui/sidebar'

interface PageHeaderProps {
    title: string
    children?: React.ReactNode
    showSidebarTrigger?: boolean
}

export const PageHeader = ({ title, children, showSidebarTrigger = true }: PageHeaderProps) => {
    return (
        <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
                {showSidebarTrigger ? <SidebarTrigger className="md:hidden" /> : null}
                <h1 className="text-3xl font-bold">{title}</h1>
            </div>
            {children && <div className="flex items-center gap-2">{children}</div>}
        </div>
    )
}
