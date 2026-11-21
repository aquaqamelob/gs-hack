'use client'

import { Avatar } from '@/components/avatar'
import { Navbar, NavbarSection, NavbarSpacer } from '@/components/navbar'
import {
  Sidebar,
  SidebarBody,
  SidebarFooter,
  SidebarHeader,
  SidebarHeading,
  SidebarItem,
  SidebarLabel,
  SidebarSection,
  SidebarSpacer,
} from '@/components/sidebar'
import { SidebarLayout } from '@/components/sidebar-layout'
import { useActor, useConnected, useMe, useMetrics } from '@/lib/client'
import {
  AdjustmentsHorizontalIcon,
  BellAlertIcon,
  BookOpenIcon,
  CircleStackIcon,
  CpuChipIcon,
  UserCircleIcon,
  UsersIcon,
} from '@heroicons/react/20/solid'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/me', label: 'My view', icon: UserCircleIcon },
  { href: '/', label: 'Live alerts', icon: BellAlertIcon, match: (p: string) => p === '/' || p.startsWith('/alerts') },
  { href: '/rules', label: 'Rules', icon: AdjustmentsHorizontalIcon },
  { href: '/schemas', label: 'Sources & schemas', icon: CircleStackIcon },
  { href: '/runbooks', label: 'Runbooks', icon: BookOpenIcon },
  { href: '/people', label: 'People & channels', icon: UsersIcon },
  { href: '/system', label: 'System & audit', icon: CpuChipIcon },
]

function ActorPicker() {
  const [actor, setActor] = useActor()
  const { me, people } = useMe()
  const known = people.some((p) => p.id === actor)
  return (
    <label className="flex items-center gap-3 rounded-lg px-2 py-2.5 text-sm/5">
      <Avatar
        initials={(me?.name ?? actor).slice(0, 2).toUpperCase()}
        className="size-8 bg-zinc-900 text-white dark:bg-white dark:text-zinc-900"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-zinc-500 dark:text-zinc-400">
          Signed in as (SSO mocked){me ? ` · ${me.role}` : ''}
        </span>
        <select
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          className="w-full bg-transparent font-medium text-zinc-950 outline-none dark:text-white"
        >
          {!known && <option value={actor}>{actor}</option>}
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.role === 'admin' ? ' (admin)' : ''}
            </option>
          ))}
        </select>
      </span>
    </label>
  )
}

function LiveIndicator() {
  const connected = useConnected()
  const m = useMetrics()
  return (
    <div className="space-y-1 px-2 text-xs/5 text-zinc-500 dark:text-zinc-400">
      <div className="flex items-center gap-2">
        <span className={`size-2 rounded-full ${connected ? 'animate-pulse bg-green-500' : 'bg-zinc-400'}`} />
        {connected ? 'Live (server push)' : 'Connecting…'}
      </div>
      {m && (
        <>
          <div>
            {m.events.toLocaleString()} events → {m.alertsCreated.toLocaleString()} alerts (15 min)
          </div>
          <div>
            e2e p50 {m.endToEnd.all.p50} ms · p99 {m.endToEnd.all.p99} ms
          </div>
          {m.pending > 0 && (
            <div className="font-medium text-amber-600 dark:text-amber-400">{m.pending} deliveries retrying</div>
          )}
          {m.dead > 0 && (
            <div className="font-medium text-red-600 dark:text-red-400">{m.dead} in dead-letter queue</div>
          )}
          <div className="truncate">instance {m.instance}</div>
        </>
      )}
    </div>
  )
}

export function ApplicationLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <SidebarLayout
      navbar={
        <Navbar>
          <NavbarSpacer />
          <NavbarSection>
            <span className="text-sm font-semibold">CTRL</span>
          </NavbarSection>
        </Navbar>
      }
      sidebar={
        <Sidebar>
          <SidebarHeader>
            <div className="flex items-center gap-3 px-2 py-2.5">
              <span className="grid size-8 place-items-center rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
                <BellAlertIcon className="size-5" />
              </span>
              <span>
                <span className="block text-sm/5 font-semibold">CTRL</span>
                <span className="block text-xs/5 text-zinc-500">self-hosted · on-call assistant</span>
              </span>
            </div>
          </SidebarHeader>

          <SidebarBody>
            <SidebarSection>
              {NAV.map(({ href, label, icon: Icon, match }) => (
                <SidebarItem key={href} href={href} current={match ? match(pathname) : pathname.startsWith(href)}>
                  <Icon />
                  <SidebarLabel>{label}</SidebarLabel>
                </SidebarItem>
              ))}
            </SidebarSection>
            <SidebarSpacer />
            <SidebarSection>
              <SidebarHeading>Status</SidebarHeading>
              <LiveIndicator />
            </SidebarSection>
          </SidebarBody>

          <SidebarFooter>
            <ActorPicker />
          </SidebarFooter>
        </Sidebar>
      }
    >
      {children}
    </SidebarLayout>
  )
}
