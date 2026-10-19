import { type FormEvent, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { isApiError } from '../api/client'
import { useLogin } from '../api/hooks'
import { CenteredPage } from '../components/CenteredPage'
import { safeNext } from '../lib/paths'
import { Alert, Button, Input } from '../ui'

/** `/login?next=` (web-ui.md §2). `next` is honoured only for in-app paths. */
export function LoginPage() {
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  const navigate = useNavigate()
  const login = useLogin()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    login.mutate({ email, password }, { onSuccess: () => navigate(next, { replace: true }) })
  }

  const err = login.error
  const message = !err
    ? null
    : isApiError(err, 'invalid_credentials')
      ? 'Wrong email or password.'
      : isApiError(err, 'busy')
        ? 'The server is busy. Try again in a moment.'
        : err.message

  return (
    <CenteredPage title="Log in">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {message && <Alert tone="danger">{message}</Alert>}
        <Input
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          loading={login.isPending}
          disabled={!email || !password}
        >
          Log in
        </Button>
        <p className="text-xs text-muted">
          No account? Accounts are created from invite links. Forgot your password? Ask an instance admin for
          a reset link.
        </p>
      </form>
    </CenteredPage>
  )
}
