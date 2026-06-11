require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'WidgetBridge'
  s.version        = package['version']
  s.summary        = package['description']
  s.author         = 'Tusk Ledger'
  s.homepage       = 'https://github.com/BradMorphsters/tuskledger'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'

  s.swift_version  = '5.4'
  s.source_files   = '**/*.{h,m,swift}'
end
