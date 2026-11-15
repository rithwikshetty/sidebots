Pod::Spec.new do |s|
  s.name           = 'Dictation'
  s.version        = '0.1.0'
  s.summary        = 'Turns a recording into text on the phone.'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = 'Simon'
  s.homepage       = 'https://github.com/rithwikshetty/simon'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.dependency 'ExpoModulesCore'
  s.static_framework = true
  s.source_files = "**/*.swift"
end
