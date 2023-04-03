zip up dependencies for aws layer (run from parent dir):

```
cp -R hearsay-lambdas nodejs
zip -r -X deps.zip nodejs -x "*/tmp/*" -x "*/layers/*" -x "*/lambda-*" -x "*/\.*"
mv deps.zip hearsay-lambdas/layers
rm -rf nodejs
```

TODO:

- add proper readme
- test with: ['m4a', 'mp3', 'webm', 'mp4', 'mpga', 'wav', 'mpeg']
- purge /tmp directory
- dotenv for testing
