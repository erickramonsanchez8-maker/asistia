param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [Parameter(Mandatory=$true)][string]$ServerIps
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:ASISTIA_CERT_PASSWORD)) { throw 'Falta la contraseña local del certificado.' }
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$caSubject = 'CN=ASISTIA Local Root CA'
$ca = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq $caSubject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $ca) {
  $ca = New-SelfSignedCertificate -Type Custom -Subject $caSubject -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage CertSign,CRLSign,DigitalSignature -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=1') -NotAfter (Get-Date).AddYears(10)
}
$rootPath = Join-Path $OutputDirectory 'asistia-local-root.cer'
Export-Certificate -Cert $ca -FilePath $rootPath -Type CERT -Force | Out-Null
$trusted = Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object { $_.Thumbprint -eq $ca.Thumbprint } | Select-Object -First 1
if (-not $trusted) { Import-Certificate -FilePath $rootPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null }
$ips = @($ServerIps.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($ips.Count -lt 1) { throw 'No se detectó una dirección IPv4 privada para ASISTIA Móvil.' }
$computerName = [System.Net.Dns]::GetHostName()
$sanParts = @('DNS=' + $computerName) + @($ips | ForEach-Object { 'IPAddress=' + $_ })
$sanText = '2.5.29.17={text}' + ($sanParts -join '&')
$server = New-SelfSignedCertificate -Type Custom -Subject 'CN=ASISTIA Local Server' -CertStoreLocation Cert:\CurrentUser\My -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @($sanText,'2.5.29.37={text}1.3.6.1.5.5.7.3.1') -NotAfter (Get-Date).AddYears(2)
$pfxPath = Join-Path $OutputDirectory 'asistia-mobile-server.pfx'
$pfxPassword = ConvertTo-SecureString $env:ASISTIA_CERT_PASSWORD -AsPlainText -Force
Export-PfxCertificate -Cert $server -FilePath $pfxPath -Password $pfxPassword -Force | Out-Null
$firewallConfigured = $false
$firewallMessage = ''
try {
  $rule = Get-NetFirewallRule -DisplayName 'ASISTIA Móvil HTTPS (red local)' -ErrorAction SilentlyContinue
  if (-not $rule) { New-NetFirewallRule -DisplayName 'ASISTIA Móvil HTTPS (red local)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 43178 -RemoteAddress LocalSubnet -Profile Private -Description 'Permite ASISTIA Móvil únicamente desde la subred local privada.' | Out-Null }
  $firewallConfigured = $true
} catch {
  $firewallMessage = 'No se pudo crear la regla automáticamente. Puede requerir permiso de administrador y perfil de red Privado.'
}
$resultPath = Join-Path $OutputDirectory 'mobile-certificate-status.json'
@{
  pfxPath = $pfxPath
  rootCertificatePath = $rootPath
  serverIps = $ips
  computerName = $computerName
  firewallConfigured = $firewallConfigured
  firewallMessage = $firewallMessage
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
} | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $resultPath
Write-Output $resultPath
